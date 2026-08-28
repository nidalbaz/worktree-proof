// Chrome Bridge background service worker (MV3).
// Connects OUT to the local relay (ws://127.0.0.1:9333/bridge) so the normal
// Chrome needs NO --remote-debugging-port. The relay exposes CDP-compatible
// HTTP/WS endpoints that agents connect to; this worker is the CDP backend.

const RELAY_URL = "ws://127.0.0.1:9333/bridge";
const PROTOCOL_VERSION = "1.3";
const RECONNECT_ALARM = "chrome-bridge-reconnect";
const RECONNECT_ALARM_PERIOD_MIN = 0.5; // keep SW alive; MV3 SWs die after ~30s idle

let ws = null;
let reconnectDelayMs = 1000;
// NOTE: debugger attachments SURVIVE service-worker death and relay restarts
// (they live in the browser process, not here). Never bulk-clear this set on
// socket loss — re-attach attempts must tolerate "already attached".
let attachedTabs = new Set(); // tabId -> true (debugger attached)

// ---------------------------------------------------------------------------
// MV3 service-worker keep-alive (pattern copied from the ChatGPT/Codex
// extension: chrome.alarms wakes the SW so the outbound WS survives).
// ---------------------------------------------------------------------------

// Top-level arming: runs on EVERY service-worker wake (alarm, event, startup),
// so the reconnect alarm always exists even if onStartup/onInstalled never
// fired in this browser session (e.g. extension loaded before relay existed).
ensureReconnectAlarm();
connect();

chrome.runtime.onStartup.addListener(() => {
  ensureReconnectAlarm();
  connect();
});

chrome.runtime.onInstalled.addListener(() => {
  ensureReconnectAlarm();
  connect();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RECONNECT_ALARM) {
    if (!ws || ws.readyState !== WebSocket.OPEN) connect();
  }
});

function ensureReconnectAlarm() {
  chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: RECONNECT_ALARM_PERIOD_MIN });
}

// ---------------------------------------------------------------------------
// Relay connection (outbound)
// ---------------------------------------------------------------------------

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return; // already connected or connecting — never duplicate
  }
  let socket;
  try {
    socket = new WebSocket(RELAY_URL);
  } catch (e) {
    scheduleReconnect();
    return;
  }
  ws = socket;
  socket.onopen = () => {
    reconnectDelayMs = 1000;
    // Announce the loaded build so the relay/operator can verify an upgrade
    // took effect. Cheap, no side effects.
    try {
      send({ type: "hello", version: chrome.runtime.getManifest().version });
    } catch {}
    sendTabs();
  };
  socket.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "command") {
      handleCommand(msg).catch((err) => {
        send({
          type: "error",
          id: msg.id,
          tabId: msg.tabId,
          error: { message: String((err && err.message) || err) },
        });
      });
    } else if (msg.type === "manage") {
      handleManage(msg).catch((err) => {
        send({
          type: "manage_error",
          opId: msg.opId,
          error: { message: String((err && err.message) || err) },
        });
      });
    } else if (msg.type === "ping") {
      send({ type: "pong" });
    } else if (msg.type === "getTabs") {
      sendTabs();
    } else if (msg.type === "selfUpgrade") {
      // Operator command from the relay: ask this service worker to reload so
      // any newly-edited background.js takes effect without opening
      // chrome://extensions. chrome.runtime.reload() only works for unpacked
      // extensions; for CRX/CWS installs we toggle enabled state via
      // chrome.management, which forces a real unload+reload.
      try {
        send({ type: "selfUpgradeAck", version: chrome.runtime.getManifest().version });
      } catch {}
      // Best-effort: try the in-process reload first; if it throws (e.g. on
      // CWS-loaded extensions), fall back to disabling+re-enabling via the
      // management API. Both paths terminate this SW; whichever wins, the
      // next wake will run the new code and reconnect with `hello` on open.
      try {
        chrome.runtime.reload();
      } catch {
        try {
          const id = chrome.runtime.id;
          chrome.management.setEnabled(id, false, () => {
            try { chrome.management.setEnabled(id, true, () => {}); } catch {}
          });
        } catch (e) {
          try { send({ type: "selfUpgradeError", error: String((e && e.message) || e) }); } catch {}
        }
      }
    }
  };
  socket.onclose = () => {
    if (ws === socket) {
      ws = null;
      // Keep attachedTabs: debugger attaches survive SW death and relay
      // restarts; clearing here causes "Already attached" errors later.
      scheduleReconnect();
    }
  };
  socket.onerror = () => {
    try {
      socket.close();
    } catch {}
  };
}

function scheduleReconnect() {
  setTimeout(connect, reconnectDelayMs);
  reconnectDelayMs = Math.min(reconnectDelayMs * 2, 15000);
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(obj));
    } catch {}
  }
}

// ---------------------------------------------------------------------------
// CDP command handling
// ---------------------------------------------------------------------------

async function handleCommand(msg) {
  const { id, tabId, method, params } = msg;
  if (typeof tabId !== "number" || !Number.isInteger(tabId)) {
    throw new Error(`chrome-bridge: command ${method} requires numeric tabId`);
  }
  await ensureAttached(tabId);
  const result = await chrome.debugger.sendCommand({ tabId }, method, params || {});
  send({ type: "result", id, tabId, result: result || {} });
}

async function ensureAttached(tabId) {
  if (attachedTabs.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, PROTOCOL_VERSION);
    attachedTabs.add(tabId);
  } catch (e) {
    const msg = String((e && e.message) || e);
    // Attachments live in the browser process, so after a service-worker
    // restart or relay reconnect Chrome may already hold an attach for this
    // tab. That is success, not failure — record it and continue.
    if (/already attached/i.test(msg)) {
      attachedTabs.add(tabId);
      return;
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Tab management (relay -> extension, no debug port needed)
// ---------------------------------------------------------------------------
//
// The relay translates HTTP-level requests (PUT /json/new, /json/close/<id>,
// GET /json/activate/<id>) into "manage" messages. We translate those into
// chrome.tabs.* APIs and reply with a "manage_result" or "manage_error"
// envelope that includes the live tab snapshot. The relay then either
// responds to the HTTP caller or refreshes its own tab cache.

async function handleManage(msg) {
  const { opId, action, params } = msg;
  if (typeof opId !== "string" || !opId) {
    throw new Error("chrome-bridge: manage requires opId");
  }
  const p = params || {};
  if (action === "tabs.create") {
    const createProps = {};
    if (typeof p.url === "string" && p.url) createProps.url = p.url;
    if (p.active === false) createProps.active = false; // default true
    if (Number.isInteger(p.windowId)) createProps.windowId = p.windowId;
    const tab = await chrome.tabs.create(createProps);
    sendTabs();
    send({
      type: "manage_result",
      opId,
      tab: {
        id: String(tab.id),
        title: tab.title || "",
        url: tab.url || (typeof p.url === "string" ? p.url : ""),
        active: !!tab.active,
        windowId: tab.windowId,
      },
    });
    return;
  }
  if (action === "tabs.remove") {
    if (!Number.isInteger(p.tabId)) {
      throw new Error("chrome-bridge: tabs.remove requires integer tabId");
    }
    await chrome.tabs.remove(p.tabId);
    attachedTabs.delete(p.tabId);
    sendTabs();
    send({ type: "manage_result", opId, tab: { id: String(p.tabId) } });
    return;
  }
  if (action === "tabs.activate") {
    if (!Number.isInteger(p.tabId)) {
      throw new Error("chrome-bridge: tabs.activate requires integer tabId");
    }
    const tab = await chrome.tabs.update(p.tabId, { active: true });
    sendTabs();
    send({
      type: "manage_result",
      opId,
      tab: {
        id: String(tab.id),
        title: tab.title || "",
        url: tab.url || "",
        active: !!tab.active,
        windowId: tab.windowId,
      },
    });
    return;
  }
  throw new Error(`chrome-bridge: unknown manage action: ${action}`);
}

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId) attachedTabs.delete(source.tabId);
});

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId) {
    send({ type: "event", tabId: source.tabId, method, params: params || {} });
  }
});

// ---------------------------------------------------------------------------
// Tab inventory (kept fresh for /json/list)
// ---------------------------------------------------------------------------

function sendTabs() {
  chrome.tabs
    .query({})
    .then((tabs) => {
      const list = tabs.map((t) => ({
        id: String(t.id),
        type: "page",
        title: t.title || "",
        url: t.url || "",
        active: !!t.active,
        windowId: t.windowId,
      }));
      send({ type: "tabs", tabs: list });
    })
    .catch(() => {});
}

chrome.tabs.onCreated.addListener(sendTabs);
chrome.tabs.onRemoved.addListener((tabId) => {
  attachedTabs.delete(tabId);
  sendTabs();
});
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.url || info.title || info.status) sendTabs();
});
chrome.tabs.onActivated.addListener(sendTabs);

connect();