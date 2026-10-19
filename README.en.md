English | [简体中文](README.md)

# dsh-mobile-access — Phone Access for DeepSeek Harness

A DeepSeek Harness plugin that lets a phone browser on the **same Wi-Fi** open
the **same Web GUI** your desktop is using. Sessions are not "synced" — the
phone and the desktop share the same Host process, the same sessions, and the
same live WebSocket. Send prompts, answer questions, approve tool calls, and
operate from your phone; the desktop sees it immediately, and vice versa.

```
Phone ──HTTP/WS──▶ Plugin LAN listener (:58218, one-time pairing code + device cookie)
                        │ reverse proxy: rewrites Host/Origin to loopback, injects the
                        │ desktop session cookie server-side, rewrites loopback absolute
                        │ URLs in responses to the LAN address
                        ▼
              Existing loopback Web GUI (no restart, no session copy)
```

## Features

- 📱 Scan-to-pair: the desktop panel shows a QR code containing a one-time
  pairing code (6 chars, 30-minute TTL, refreshable)
- 🔐 Security by construction: the desktop session cookie never leaves the
  Host process (upstream `Set-Cookie` is stripped); pairing codes are
  single-use and compared in constant time; unpaired requests get a bare 401;
  pairing endpoints are loopback-only; device list is capped (10) and lives
  only in process memory — a restart revokes everything (fail-closed)
- 🧩 Zero runtime dependencies, no build step, no online services (offline QR)
- 🌐 Full GUI on the phone: chat, approvals, terminals, files — same as desktop

## Install

```sh
dsh plugin --profile <your-profile> add github:<you>/dsh-mobile-access
# or, from a local checkout:
dsh plugin --profile <your-profile> add /path/to/dsh-mobile-access
```

Then open the Web GUI: a **📱 Phone Access** floating button appears in the
bottom-right corner (or visit `http://127.0.0.1:<port>/__mobile/`).

## Configuration

Set in the bundle patch row's `config` (see `cordis.patch.yml`):

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Turn the LAN listener off without uninstalling |
| `host` | auto | LAN IPv4 to bind; empty = first non-internal IPv4; `0.0.0.0` binds all interfaces (advertises the auto-detected LAN IP) |
| `port` | `58218` | LAN listener port |

## Known limitations

- LAN only; for remote access front it with your own tunnel (e.g. Tailscale)
  and set `host` accordingly.
- Plain HTTP on the LAN (matching the desktop GUI's own loopback transport);
  do not use on untrusted networks.
- Devices must re-pair after the Harness process restarts (keys are
  memory-only by design).
- The desktop GUI layout is not mobile-optimized; everything works, but it is
  a desktop layout on a small screen.
- macOS may prompt once to allow incoming connections.

## Verification

`node tests/verify.mjs` runs 15 end-to-end checks against a live install
(pairing gate, proxy, HTML/JSON rewriting, WebSocket upgrade, negatives).
Exit code 0 = all pass.

## License

[MIT](LICENSE). `public/qr.js` vendors Kazuhiko Arase's MIT-licensed
QR encoder — see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
