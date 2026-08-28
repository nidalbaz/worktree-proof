# opencode-plugin-computer-use — CHANGELOG

## 1.1.0 — 2026-08-28

Adds chrome-bridge awareness. The plugin now talks to the chrome-bridge
relay (the same one the chrome-use plugin uses) so the agent can drive
the user's real Chrome over the no-port named pipe
`\\.\pipe\chrome-bridge` (falls back to `http://127.0.0.1:9333`).

New tools:

| Tool                  | Purpose                                                      |
| --------------------- | ------------------------------------------------------------ |
| `cu_browser_tabs`     | List the user's normal Chrome tabs via the bridge.          |
| `cu_browser_activate` | Focus a Chrome tab by id.                                    |
| `cu_browser_open`     | Open a new Chrome tab via the bridge.                       |
| `cu_browser_close`    | Close a Chrome tab by id.                                    |
| `cu_browser_evaluate` | Run JavaScript in a Chrome tab (CDP Runtime.evaluate).      |
| `cu_browser_screenshot` | Capture a Chrome tab as PNG.                              |
| `cu_browser_bridge_status` | Report transport (pipe vs TCP) + extension version.    |

When to use which tool:

- `cu_browser_*` (new): the target is a web page rendered in the
  user's normal Chrome. Use CDP via the bridge — faster, no
  focus-fighting, immune to terminal focus-stealing, and no port
  appears in `netstat` for the agent (the bridge itself stays on
  loopback only).
- `cu_mouse_*` / `cu_keyboard_*` / `cu_window_*` (existing): the target
  is the browser chrome (URL bar, tab strip, settings), or a non-browser
  desktop app.

Environment:

- `CHROME_BRIDGE_PIPE` (default `chrome-bridge`): the named pipe name.
  When set on the agent process, the plugin uses the pipe; otherwise
  it falls back to HTTP.
- `CHROME_BRIDGE_PORT` (default `9333`): the TCP port to use when the
  pipe is unavailable.

## 1.0.0 — initial

OS-level mouse / keyboard / window automation via `nut-js`, plus
desktop screenshot. No browser integration.
