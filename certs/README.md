# Telno root CA (public certificate)

`telno-root-ca.crt` is the **public** root certificate of the Caddy internal CA that signs the
console's TLS certificate. Installing it on a device or workstation makes
`https://192.168.1.17:8443` verify normally, with no browser warning.

| | |
|---|---|
| Subject | `CN=Caddy Local Authority - 2026 ECC Root` |
| SHA-256 fingerprint | `77:9C:E8:A5:D0:06:56:A1:6C:7D:AE:03:F0:F0:AB:BF:23:8F:FE:20:66:29:CA:95:1B:6C:0D:E2:7A:29:54:9C` |
| Valid | 2026-10-29 → 2036-09-06 |
| Key | Held by Caddy at `%AppData%\Caddy\pki\authorities\local\root.key` — **never** commit it |

This file is safe to publish: it is only ever used to *verify* signatures. It signs nothing on
its own.

## Installing it

```powershell
# This workstation, current user (no elevation)
certutil -addstore -user Root certs\telno-root-ca.crt

# A T750 / HT802, if the firmware accepts a PEM or DER upload for its trust store
#   upload certs/telno-root-ca.crt (PEM) — convert to DER with:
openssl x509 -in certs/telno-root-ca.crt -outform der -out certs/telno-root-ca.der
```

## Devices that cannot trust a private CA

Point them at the plain-HTTP provisioning listener instead — it serves **only** `/prov` and only
to private address ranges:

```
http://192.168.1.17:8088/prov/v1/enroll
http://192.168.1.17:8088/prov/v1/config
```

## When the CA changes

Caddy recreates this CA if its data directory is wiped (`%AppData%\Caddy\pki`). The fingerprint
above then no longer matches, every device trusts the wrong root, and this file must be replaced:

```bash
cp "$AppData/Caddy/pki/authorities/local/root.crt" certs/telno-root-ca.crt
certutil -delstore -user Root 779CE8A5D00656A16C7DAE03F0F0ABBF238FFE206629CA951B6C0DE27A29549C
certutil -addstore -user Root certs/telno-root-ca.crt
```
