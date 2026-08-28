# chrome-bridge

No-port CDP bridge: a small extension inside your normal Chrome (no
`--remote-debugging-port`) attaches `chrome.debugger` lazily and proxies
CDP commands/events to a local relay. Two transports:

- **TCP** on `127.0.0.1:9333` for the Chrome extension uplink and any
  tool that already speaks HTTP+WebSocket.
- **Named pipe** on `\\.\pipe\chrome-bridge` for agents that want zero
  ports — `netstat` will not show a single number, identical to how
  ChatGPT / Claude desktop connect to their local services.

Both transports are exposed when `CHROME_BRIDGE_PIPE` is set; the
extension always uses TCP because it lives inside Chrome.

## Endpoints

| Method  | Path                       | Purpose                                        |
| ------- | -------------------------- | ---------------------------------------------- |
| GET     | `/json/version`            | CDP browser info (also reports active transports) |
| GET     | `/json/list`               | Tabs the extension currently sees              |
| PUT     | `/json/new`                | Open a new tab (body: `{url?, active?, windowId?}`) |
| PUT     | `/json/close/<id>`         | Close a tab                                    |
| GET     | `/json/activate/<id>`      | Focus a tab                                    |
| GET     | `/extension-version`       | Manifest version of the loaded extension      |
| POST    | `/self-upgrade`            | Ask the extension to reload itself (v0.2.0+)   |
| WS      | `/devtools/page/<id>`      | CDP session for one tab (TCP only)             |
| WS      | `/bridge`                  | Extension uplink (TCP, internal)               |

## Pipe protocol

Same endpoint set, framed as length-prefixed JSON envelopes over the
named pipe:

```
[ uint32 BE length ][ utf8 JSON envelope ... ]
```

Envelope shapes:

| Type        | From       | Fields                                          |
| ----------- | ---------- | ----------------------------------------------- |
| `req`       | agent      | `id, method, path, body?`                       |
| `res`       | relay      | `id, status, body`                              |
| `cdp_attach`| agent      | `id, tabId`                                     |
| `cdp_detach`| agent      | `id`                                            |
| `cdp`       | agent      | `id, tabId, method, params?`                    |
| `cdp_res`   | relay      | `id, result? | error?`                          |
| `cdp_evt`   | relay      | `tabId, method, params`                         |

A single pipe handles both control (`req`/`res`) and per-tab data
(`cdp`/`cdp_res`/`cdp_evt`) multiplexed. Only one agent may hold the
pipe at a time; a second client is dropped immediately so callers
see `ECONNRESET` rather than a silent stall.

Minimal pipe client (~20 lines of `node:net`) is in `test/pipe.test.mjs`.

## One-time manual reload (the only UI step)

When you first upgrade from v0.1.0 to v0.2.0+:

1. Open `chrome://extensions/` in Chrome.
2. Toggle the **Chrome Bridge (no-port CDP relay client)** extension off
   and back on (or click the refresh icon).
3. Hit `POST /self-upgrade` (or just restart the relay) — the extension
   re-runs the new `background.js`, announces its version via the
   `hello` message, and the bridge records it (`/extension-version`
   shows it).

From then on, every code change to `background.js` is picked up by
`POST /self-upgrade` — the extension calls `chrome.runtime.reload()`
(unpackaged install) or `chrome.management.setEnabled` (CWS CRX), then
reconnects with the new build.

## Run

```
# TCP only (the previous default)
node server.mjs

# TCP + named pipe (recommended for new setups)
CHROME_BRIDGE_PIPE=chrome-bridge node server.mjs

# Custom port + custom pipe name
CHROME_BRIDGE_PORT=19333 CHROME_BRIDGE_PIPE=chrome-bridge-dev node server.mjs
```

The `run-bridge.cmd` script in this directory does the same on Windows
and pipes stdout to `%TEMP%\bridge.log`.

## Tests

```
npm test
```

12 tests across two files: 7 for the TCP transport, 5 for the named
pipe (including a CDP round-trip that opens a tab and runs
`Runtime.evaluate` over the same pipe).
