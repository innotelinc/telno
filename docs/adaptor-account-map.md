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

The identity itself is checked before a socket opens. `@telno/shared` owns the
rule (`EXTENSION_PATTERN`, two to six digits) and hands back the sentence to
show, so the console field, the write route and the driver all refuse `20l` with
"an extension is 2 to 6 digits" instead of storing it and letting the line
register as nothing. The rule belongs to the platform, not the adaptor: the
firmware accepts whatever string it is handed, which is precisely why a typo on
the box is silent.

## Registered is not the same as ringing

A well-formed extension that is not this port's to use is written anyway, with a
warning. The unit will register it and report `registered` — the device sheet has
no way to tell that apart from a working line — so `lineAssignment()` in
`apps/server/src/estate.ts` is asked before the write, and the answer rides back
on the write as `warning`, into the audit event, and out as a toast in the
console. It reports three states, and only the first is quiet:

| the line today | what the operator is told |
|---|---|
| held by this port | nothing |
| not assigned to any device | nothing — a free line is what a port is for |
| no such line in the estate | `No line in this estate uses 999, so the port will register and then ring nowhere until one does.` |
| assigned to another device | `Line 201 is assigned to Reception phone at Ground floor, so this port and Reception phone at Ground floor would both answer as 201 and a call could land on either handset.` |
| assigned to the other port on this adaptor | `Line 201 is assigned to port 2 of this adaptor, so ports 2 and 1 would both answer as 201.` |

It warns instead of refusing because the estate's own 201 and 202 sat on this
hardware before the platform had a record of them, and an operator may be
deliberately ahead of the line inventory. Refusing would make the adaptor sheet
unable to do the job it exists for.

The wording avoids claiming which handset wins. Two registrations of one address
is a race the SIP server arbitrates, not something the platform can predict, and
a message that guessed would send the operator looking in the wrong place.

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

## Doing it from the console

The device sheet now carries the write: each line in the adaptor panel has a
**Set extension** / **Change extension** button, and the form it opens sends the
same `POST /api/devices/:id/ata/accounts` the API documents. Three details are
deliberate:

- The **Telno line** column shows which platform line an installer assigned to
  that slot (`lines.account_slot`), so the box and the platform are read side by
  side rather than trusted to agree. Opening the editor prefills from the
  platform and says so when the two disagree.
- **Registration** is a three-state badge: registered, not registered, or "not
  reported" for firmware that cannot say. An unknown is never drawn as a fault.
- The sheet **re-probes the device** after a write instead of redrawing the row
  from the form, so what appears is the read-back, not the request. On units
  whose firmware takes an account by form post rather than by API, the button is
  absent and the panel says why — there is no write path to offer.

## Refused passwords, and why the platform stops knocking

Both firmware families count failed logins. The V1 answers `/cgi-bin/api-get_lockouts`
without a session, so its client can read the timer and wait it out. The TLS
console does not: it answers `wrongN` with the attempts left and then simply
stops accepting passwords for a duration nothing on the box reports.

That asymmetry mattered once the console could write. Opening the device sheet
logs in, and the write logs in again, so a stale `TELNO_ATA_PASSWORD` would
spend an attempt every time somebody looked at the page — locking the unit out of
its own console by accident. The refusal memory is therefore shared: same guard,
same back-off, both firmwares.

- A refusal is recorded per device against a digest of the password that was
  refused, so correcting the credential is not blocked by the old one's cooldown.
- Cooldown is 5 minutes, then 15, then no further attempts until the credential
  changes and the platform restarts.
- The unit's `wrongN` is honoured: with two attempts left the platform spends
  none, because those last two belong to whoever is standing at the device.
- During a cooldown the adaptor view reports `state: auth` with `locked` and
  `remainSec` set from the platform's own timer, and says plainly that it is the
  platform withholding the password — the unit's timer is not readable, so
  presenting it as the device's would be a guess dressed as a measurement.

## The ledger keeps what it replaced

A write returns `previous` — the line's identity as read with the same session
that overwrote it — and the event carries it in both the message and the meta:

```
Adaptor line 2 at 192.168.1.5 was changed from 8579901777 to 201 and read back as 201.
{ account: 2, from: '8579901777', fromAuthId: '8579901777',
  fromName: 'Denovo Credit Corp', fromRegistration: 'registered',
  readableBefore: true, to: '201' }
```

Three outcomes are distinguished rather than collapsed into one sentence:

- `was changed from X to Y` — the line held something else, and the ledger names it.
- `was rewritten as Y, unchanged` — the write was a no-op on identity.
- `could not be read beforehand` — the unit answered with blanks (a stale session);
  recorded as unknown, never as "an empty slot".

That last case is the reason `previous` is nullable. A stale session on this
firmware answers `success` with empty strings, so "nothing was there" and "the
read failed" look identical unless the driver asks for a canary field, which
`accountState()` does. Recording a failed read as an empty slot would turn the
one query an audit exists to answer into a confident wrong answer.
## How the write contract is tested

`apps/server/test/adaptor.test.ts` runs the driver against a fake TLS console on
127.0.0.1 rather than a unit on the bench. The fake mints its own certificate at
test time (it needs `openssl` on `PATH`; no key is committed), and it reproduces
the three behaviours that make this path hard to verify by hand: a write is
acknowledged before it is applied, a stale session answers `success` with blanks,
and a refused password answers `wrongN` with the attempts left.

Pinned: the identity the ledger records as replaced, the P numbers actually
posted (and that the ignored dotted projection is never used, and the secret is
written but never read), `applied: false` when the unit acknowledges and stores
nothing, `previous: null` when the slot could not be read, and that a refused
password posts no write at all.
