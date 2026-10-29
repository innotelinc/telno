# The adaptor's account block, as measured

This is the map a line is written through. It was not taken from a manual: it was
read out of the unit's own console bundle and then verified by writing to the box
and reading the values back.

## Why the obvious keys do not work

The firmware's console loads its page definitions from
`json/contents/dect_acct_settings.js`, fetched from the unit itself. That file
names the columns of the SIP account table — `SIP_USER`, `SIP_AUTH`, `SIP_PASS`,
`SIP_NAME`, `SIP_PROFILE` — and each cell resolves to **two** keys: a `P` number
and a dotted name.

```
account.1.sip.user_id      reads back correctly   write accepted, ignored
P4060                      reads back correctly   write applied
```

`POST /cgi-bin/api.values.post` answers `{"status":"right"}` to either. Only the
`P` number changes anything. This is the whole reason the platform spent so long
writing identities the unit never used: the read was real, the write was a no-op,
and the acknowledgement said it had worked.

## The map

Index `n` is one-based, so account 2 is `P4061`, `P4091`, `P4121`, `P4181`.

| Meaning | Parameter | Example read back |
|---|---|---|
| SIP user id | `P4060 + (n-1)` | `201` |
| Authenticate id | `P4090 + (n-1)` | `201` |
| Authenticate password | `P4120 + (n-1)` | written, never read |
| Display name | `P4180 + (n-1)` | `Fire panel line` |
| Registration state | `P4921 + (n-1)` | `1` registered, `2` not |

Ten slots exist (`ACCOUNT_SLOTS`). An empty user id is an empty slot, not a broken
port — the unit ships with two of the ten used.

The SIP server address is not in the account row. It comes from the profile the
account is bound to: `account.N.sip.profile_id` is **zero-based** (profile 1 is
`0`), and the address behind it is `profile.M.sip.server.1.address`.

`P4921…P4930` is the part that changes what the console may claim: this firmware
**does** report live registration per account. The V1 console only ever shows
configuration, so its ports say `configured`; this one says `registered` or
`not registered`, and the platform no longer has to hedge.

## The write contract

`POST /api/devices/:id/ata/accounts` (session required):

```json
{ "account": 2, "extension": "202", "secret": "…", "name": "Lift line" }
```

The driver writes the block above, waits for the configuration to settle, and
then **reads the values back**. `applied` is true only when `P4060+n` and
`P4090+n` return the new identity. A refusal or a silent drop comes back as
`applied: false` with a reason — never as success. The password is written to the
box and is never read, returned, logged or stored by the platform.

## Measured on a real unit

```
before   P4060 774505••••  P4061 857990••••  P4921 1  P4922 2
write    P4060 201        P4061 202        P4090/4091 201/202
readback P4060 201        P4061 202        P4921 1  P4922 1
```

Both accounts came back `1` within seconds of the write, with no reboot and no
provisioning cycle. The two numbers that were there before belong to real
customers and are masked here.

## Corrections this map forced

- The unit in this estate answers `phone_model` = `DP750`: ten account slots, no
  FXS ports. The earlier `P271`/`P35`/`P47`/`P40` map described a different box,
  and writing to it produced no registration at all. The identity card now shows
  the model the unit reports rather than the model the platform assumed.
- A user id and a secret are not a registration. The switch has to know the
  account too; the earlier notes asserted the opposite.
