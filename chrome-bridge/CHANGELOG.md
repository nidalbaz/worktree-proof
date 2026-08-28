# chrome-bridge upgrade — 2026-08-28

The chrome-bridge relay (the only sanctioned way for agents to drive the
user's normal no-port Chrome) is upgraded to v0.2.0. The upgrade is
additive — every existing endpoint works unchanged, plus tab management,
self-upgrade, and an optional no-port named-pipe transport for agents.

## What's new

| Endpoint              | Purpose                                              |
| --------------------- | ---------------------------------------------------- |
| `PUT  /json/new`      | Open a new tab in the user's main Chrome             |
| `PUT  /json/close/<id>` | Close a tab by id                                  |
| `GET  /json/activate/<id>` | Focus a tab by id                               |
| `GET  /extension-version`  | Manifest version of the loaded extension        |
| `POST /self-upgrade`       | Ask the extension SW to reload itself         |

All five are wired through the new `handleRequest({method, pathname, body})`
in `server.mjs` and are served by **both** the TCP transport
(`127.0.0.1:9333`) and the new named-pipe transport
(`\\.\pipe\chrome-bridge`).

## Tab management (the missing piece)

Until now, agents could only observe tabs via `GET /json/list`. They could
not create, close, or focus them. The chrome-bridge upgrade adds the
standard CDP-shaped management endpoints, implemented by the extension's
new `handleManage` (in `extension/background.js`) which calls
`chrome.tabs.create`/`remove`/`update`. This unlocks:

- Programmatic tab opening for new sessions / logins
- Closing ephemeral tabs after scrapes
- Focusing a specific tab for screenshot or interaction

## Self-upgrade (one-time manual, then automatic)

The extension SW is loaded once when Chrome starts it. Updating
`background.js` on disk is not enough — Chrome must re-parse the file.
The first time the extension upgrades from v0.1.0 to v0.2.0+, the user
must do a one-time manual reload at `chrome://extensions` (toggle the
extension off and back on). After that, every subsequent code change
ships via `POST /self-upgrade`:

1. Agent calls `POST /self-upgrade` over the pipe or HTTP.
2. The relay sends `{type: "selfUpgrade"}` to the extension.
3. The extension calls `chrome.runtime.reload()` (unpackaged install)
   or falls back to `chrome.management.setEnabled` (CWS CRX install).
4. The new SW re-spawns, opens its WS uplink, and announces its
   `version` via the new `hello` message.
5. `GET /extension-version` now returns the new `manifestVersion`.

## Named-pipe transport (no port for agents)

`netstat` shows 9333 only on the loopback interface — invisible to the
LAN. For tools that want **zero** port numbers visible anywhere, set
`CHROME_BRIDGE_PIPE=chrome-bridge` when starting the relay. Agents then
talk to `\\.\pipe\chrome-bridge` over a length-prefixed JSON envelope:

```
[ uint32 BE length ][ utf8 JSON envelope ... ]
```

Envelope shapes (in `server.mjs` `handlePipeEnvelope`):

- `{type:"req", id, method, path, body?}`  →  `{type:"res", id, status, body}`
- `{type:"cdp_attach", id, tabId}`        →  `{type:"res", id, status, body}`
- `{type:"cdp_detach", id}`               →  `{type:"res", id, status, body}`
- `{type:"cdp", id, tabId, method, params?}` → `{type:"cdp_res", id, result|error}`
- `{type:"cdp_evt", tabId, method, params}`  (zero or more, async)

A single pipe handles control (`req`/`res`) and per-tab data
(`cdp`/`cdp_res`/`cdp_evt`) multiplexed. Only one agent may hold the
pipe at a time; a second client is dropped immediately so callers
see `ECONNRESET` rather than a silent stall.

The TCP transport is still the default. Both are exposed when
`CHROME_BRIDGE_PIPE` is set, with identical features.

## How to run

```
# TCP only (unchanged from before)
node chrome-bridge/server.mjs

# TCP + named pipe (recommended for new deployments)
cmd /c chrome-bridge\run-bridge.cmd
# or
CHROME_BRIDGE_PIPE=chrome-bridge node chrome-bridge/server.mjs
```

`run-bridge.cmd` sets the pipe name and redirects stdout to
`%TEMP%\bridge.log`.

## How to test

```
cd chrome-bridge
node --test test/relay.test.mjs test/pipe.test.mjs
```

12 tests: 7 covering the TCP transport, 5 covering the named-pipe
transport (including a CDP round-trip that opens a tab, attaches a
CDP session over the pipe, runs `Runtime.evaluate`, and gets a real
result back).

## Verification

- `GET /json/version` reports `"transport":"tcp+pipe"` when the pipe
  is enabled, `"transport":"tcp"` otherwise.
- `GET /extension-version` returns `{"extensionVersion":"0.2.0",
  "manifestVersion":"0.2.0"}` after the running SW reloads.
- The bridge log shows `extension hello version=0.2.0` on every
  successful upgrade.
