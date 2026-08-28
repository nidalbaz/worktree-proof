#!/usr/bin/env node
// Chrome Bridge relay server.
// Listens on 127.0.0.1:9333 and exposes CDP-compatible endpoints that agents
// connect to (chrome_connect / chrome_* tools). The real CDP backend is the
// Chrome Bridge extension running inside the user's NORMAL Chrome (no debug
// port): the extension connects OUT to ws://127.0.0.1:9333/bridge and this
// relay proxies commands/events between agents and the extension.
//
// Endpoints (TCP, on 127.0.0.1:9333):
//   GET  /json/version          -> browser info (CDP-compatible)
//   GET  /json/list             -> tabs reported by the extension
//   PUT  /json/new              -> open a new tab
//   PUT  /json/close/<id>       -> close a tab
//   GET  /json/activate/<id>    -> focus a tab
//   POST /self-upgrade          -> ask extension to reload itself
//   GET  /extension-version     -> manifest version of the loaded extension
//   WS   /devtools/page/<id>    -> CDP session proxy for one tab
//   WS   /bridge                -> extension uplink (internal)
//
// Endpoints (named pipe, on \\.\pipe\chrome-bridge when CHROME_BRIDGE_PIPE
// is set): identical features over a length-prefixed JSON envelope
// protocol — no port number, no netstat entry, no firewall prompt. The pipe
// is for agent-side use only; the extension stays on TCP/WS.
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import { WebSocketServer, WebSocket } from "ws";

const PORT = Number(process.env.CHROME_BRIDGE_PORT || 9333);
const HOST = "127.0.0.1";
const PIPE_NAME = process.env.CHROME_BRIDGE_PIPE || "";

let extensionSocket = null; // the single extension uplink
let lastPongAt = 0; // last keepalive pong from the extension (0 = none yet)
let tabCache = []; // last tabs payload from the extension
let extensionVersion = "unknown"; // manifest version of the loaded extension
const browserVersion = `Chrome/151.0.7922.138 (via chrome-bridge)`;
let nextConnId = 1;
const pageSockets = new Map(); // tabId(string) -> Set<agent ws>
const pendingByRelayId = new Map(); // relayId -> { socket, tabId }
const pendingManage = new Map(); // opId -> { resolve, reject, timer }

// ---------------------------------------------------------------------------
// HTTP endpoints (TCP) and pipe endpoints (\\.\pipe\chrome-bridge) share the
// same logic via handleRequest({ method, path, body }) -> { status, body }.
// ---------------------------------------------------------------------------

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

const devtoolsBase = (tabId) =>
  `ws://${HOST}:${PORT}/devtools/page/${tabId}`;

// Returns { status, body } for the given (method, path, parsedJsonBody).
// Used by the TCP/HTTP transport and the named-pipe transport.
async function handleRequest({ method, pathname, body }) {
  body = body || {};
  if (method === "GET" && pathname === "/json/version") {
    return {
      status: 200,
      body: {
        Browser: browserVersion,
        "Protocol-Version": "1.3",
        "User-Agent": browserVersion,
        "V8-Version": "13.0",
        "WebKit-Version": "615.1",
        webSocketDebuggerUrl: `ws://${HOST}:${PORT}/devtools/browser/0`,
        transport: PIPE_NAME ? "tcp+pipe" : "tcp",
        pipeName: PIPE_NAME || null,
      },
    };
  }
  if (method === "GET" && pathname === "/json/list") {
    return {
      status: 200,
      body: tabCache.map((t) => ({
        id: t.id,
        type: "page",
        title: t.title || "",
        url: t.url || "",
        webSocketDebuggerUrl: devtoolsBase(t.id),
        devtoolsFrontendUrl: `devtools://devtools/bundled/inspector.html?ws=${HOST}:${PORT}/devtools/page/${t.id}`,
      })),
    };
  }
  // PUT /json/new  body: { url?, active?, windowId? } -> { id, type, title, url, webSocketDebuggerUrl }
  if (method === "PUT" && pathname === "/json/new") {
    if (!extensionSocket || extensionSocket.readyState !== WebSocket.OPEN) {
      return { status: 503, body: { error: "chrome-bridge: extension not connected" } };
    }
    const op = {
      type: "manage",
      opId: `m${Date.now()}:${nextConnId++}`,
      action: "tabs.create",
      params: {
        url: typeof body.url === "string" ? body.url : undefined,
        active: body.active === undefined ? true : !!body.active,
        windowId: Number.isInteger(body.windowId) ? body.windowId : undefined,
      },
    };
    try {
      const reply = await sendManageAndAwait(op, 5000);
      if (!reply || reply.type === "error") {
        return { status: 502, body: { error: (reply && reply.error && reply.error.message) || "extension failed" } };
      }
      const tab = reply.tab || {};
      upsertTab(tab);
      return {
        status: 200,
        body: {
          id: tab.id,
          type: "page",
          title: tab.title || "",
          url: tab.url || "",
          webSocketDebuggerUrl: devtoolsBase(tab.id),
          devtoolsFrontendUrl: `devtools://devtools/bundled/inspector.html?ws=${HOST}:${PORT}/devtools/page/${tab.id}`,
        },
      };
    } catch (e) {
      return { status: 504, body: { error: String((e && e.message) || e) } };
    }
  }
  // PUT /json/close/<id>  -> { success: true }
  if (method === "PUT" && pathname.startsWith("/json/close/")) {
    const tabId = decodeURIComponent(pathname.slice("/json/close/".length));
    if (!extensionSocket || extensionSocket.readyState !== WebSocket.OPEN) {
      return { status: 503, body: { error: "chrome-bridge: extension not connected" } };
    }
    try {
      const reply = await sendManageAndAwait(
        { type: "manage", opId: `m${Date.now()}:${nextConnId++}`, action: "tabs.remove", params: { tabId: Number(tabId) } },
        5000
      );
      if (!reply || reply.type === "error") {
        return { status: 502, body: { error: (reply && reply.error && reply.error.message) || "extension failed" } };
      }
      removeTab(String(tabId));
      return { status: 200, body: { success: true } };
    } catch (e) {
      return { status: 504, body: { error: String((e && e.message) || e) } };
    }
  }
  // GET /json/activate/<id>  -> { success: true }
  if (method === "GET" && pathname.startsWith("/json/activate/")) {
    const tabId = decodeURIComponent(pathname.slice("/json/activate/".length));
    if (!extensionSocket || extensionSocket.readyState !== WebSocket.OPEN) {
      return { status: 503, body: { error: "chrome-bridge: extension not connected" } };
    }
    try {
      const reply = await sendManageAndAwait(
        { type: "manage", opId: `m${Date.now()}:${nextConnId++}`, action: "tabs.activate", params: { tabId: Number(tabId) } },
        5000
      );
      if (!reply || reply.type === "error") {
        return { status: 502, body: { error: (reply && reply.error && reply.error.message) || "extension failed" } };
      }
      return { status: 200, body: { success: true } };
    } catch (e) {
      return { status: 504, body: { error: String((e && e.message) || e) } };
    }
  }
  if (method === "POST" && pathname === "/self-upgrade") {
    if (!extensionSocket || extensionSocket.readyState !== WebSocket.OPEN) {
      return { status: 503, body: { error: "chrome-bridge: extension not connected" } };
    }
    try {
      extensionSocket.send(JSON.stringify({ type: "selfUpgrade" }));
    } catch (e) {
      return { status: 502, body: { error: String((e && e.message) || e) } };
    }
    return {
      status: 202,
      body: { accepted: true, note: "if extension is on <v0.2.0, do a one-time manual reload at chrome://extensions" },
    };
  }
  if (method === "GET" && pathname === "/extension-version") {
    return { status: 200, body: { extensionVersion, manifestVersion: "0.2.0" } };
  }
  if (method === "POST" && pathname === "/open-extensions-page") {
    if (!extensionSocket || extensionSocket.readyState !== WebSocket.OPEN) {
      return { status: 503, body: { error: "chrome-bridge: extension not connected" } };
    }
    try {
      const reply = await sendManageAndAwait(
        { type: "manage", opId: `m${Date.now()}:${nextConnId++}`, action: "tabs.create", params: { url: "chrome://extensions/" } },
        5000
      );
      if (!reply || reply.type === "error") {
        return { status: 502, body: { error: (reply && reply.error && reply.error.message) || "extension failed" } };
      }
      return { status: 200, body: { success: true, tab: reply.tab } };
    } catch (e) {
      return { status: 504, body: { error: String((e && e.message) || e) } };
    }
  }
  if (pathname.startsWith("/json/") || pathname.startsWith("/devtools/")) {
    return { status: 404, body: { error: "not found" } };
  }
  return { status: 404, body: { error: "use /json/version, /json/list, /json/new, /json/close/<id>, /json/activate/<id>, /self-upgrade, /extension-version, /devtools/page/<id> (TCP) or any of the same paths via the named pipe" } };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || HOST}`);
  let body = {};
  if (req.method !== "GET" && req.method !== "HEAD") {
    try {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw) body = JSON.parse(raw);
    } catch {
      sendJson(res, 400, { error: "invalid json body" });
      return;
    }
  }
  const out = await handleRequest({ method: req.method, pathname: url.pathname, body });
  sendJson(res, out.status, out.body);
});

// ---------------------------------------------------------------------------
// WebSocket handling
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({ server });

function isExtensionUplink(req) {
  const url = new URL(req.url, `http://${req.headers.host || HOST}`);
  return url.pathname === "/bridge";
}

function pageTargetIdFromUrl(req) {
  const url = new URL(req.url, `http://${req.headers.host || HOST}`);
  const m = url.pathname.match(/^\/devtools\/page\/(.+)$/);
  return m ? decodeURIComponent(m[1]) : null;
}

wss.on("connection", (socket, req) => {
  if (isExtensionUplink(req)) {
    // Extension uplink: replace any previous socket (stale/zombie sockets from
    // a terminated service worker must never block a live reconnect).
    if (extensionSocket && extensionSocket.readyState === WebSocket.OPEN) {
      try {
        extensionSocket.terminate();
      } catch {}
    }
    extensionSocket = socket;
    lastPongAt = Date.now();
    console.log(`[bridge] extension uplink connected (${new Date().toISOString()})`);
    socket.on("message", (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg && msg.type === "hello") {
        extensionVersion = msg.version || "unknown";
        console.log(`[bridge] extension hello version=${extensionVersion}`);
        return;
      }
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "tabs") {
        tabCache = Array.isArray(msg.tabs) ? msg.tabs : [];
      } else if (msg.type === "result" || msg.type === "error") {
        routeToPageSocket(msg);
      } else if (msg.type === "manage_result" || msg.type === "manage_error") {
        routeManageReply(msg);
      } else if (msg.type === "event") {
        routeEventToPageSockets(msg);
      } else if (msg.type === "pong") {
        // keepalive ack
        lastPongAt = Date.now();
      }
    });
    socket.on("close", () => {
      if (extensionSocket === socket) extensionSocket = null;
    });
    socket.on("error", () => {
      if (extensionSocket === socket) extensionSocket = null;
    });
    return;
  }

  const tabId = pageTargetIdFromUrl(req);
  if (tabId === null) {
    socket.close(4001, "expected /devtools/page/<id> or /bridge");
    return;
  }

  // Agent page session.
  const connId = nextConnId++;
  if (!pageSockets.has(tabId)) pageSockets.set(tabId, new Set());
  const set = pageSockets.get(tabId);
  set.add(socket);

  socket.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;
    if (typeof msg.id !== "number" || typeof msg.method !== "string") return;
    const relayId = `${connId}:${msg.id}`;
    pendingByRelayId.set(relayId, { socket, tabId });
    const ok = sendToExtension({
      type: "command",
      id: relayId,
      tabId: Number(tabId),
      method: msg.method,
      params: msg.params || {},
    });
    if (!ok) {
      pendingByRelayId.delete(relayId);
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(
          JSON.stringify({
            id: msg.id,
            error: { message: "chrome-bridge: extension not connected" },
          })
        );
      }
    }
  });

  socket.on("close", () => {
    set.delete(socket);
    if (set.size === 0) pageSockets.delete(tabId);
    for (const [rid, entry] of pendingByRelayId) {
      if (entry.socket === socket) pendingByRelayId.delete(rid);
    }
  });
  socket.on("error", () => socket.close());
});

function sendToExtension(obj) {
  if (extensionSocket && extensionSocket.readyState === WebSocket.OPEN) {
    extensionSocket.send(JSON.stringify(obj));
    return true;
  }
  return false;
}

function routeToPageSocket(msg) {
  const rid = String(msg.id || "");
  const sep = rid.indexOf(":");
  if (sep < 0) return;
  const origId = Number(rid.slice(sep + 1));
  const entry = pendingByRelayId.get(rid);
  if (!entry) return;
  pendingByRelayId.delete(rid);
  const { socket } = entry;
  // Real WebSocket agents: must be OPEN. Pipe shims have no readyState;
  // treat anything that exposes a `send` function as ready (the shim's
  // socket lifecycle is owned by the pipe connection handler).
  const isOpen = !socket.readyState || socket.readyState === WebSocket.OPEN;
  if (!isOpen) return;
  const out = { id: origId };
  if (msg.type === "result") out.result = msg.result || {};
  else out.error = msg.error || { message: "unknown error" };
  // Real ws: socket.send takes a string. Pipe shim: send takes an object
  // and wraps it in a cdp_res envelope. Sniff via a marker on the shim.
  if (socket.isPipe) socket.send(out);
  else socket.send(JSON.stringify(out));
}

function routeEventToPageSockets(msg) {
  const set = pageSockets.get(String(msg.tabId));
  if (!set) return;
  const out = JSON.stringify({ method: msg.method, params: msg.params || {} });
  for (const sock of set) {
    if (sock.readyState === WebSocket.OPEN) sock.send(out);
  }
}

// ---------------------------------------------------------------------------
// Tab cache helpers (so /json/list reflects /json/new immediately)
// ---------------------------------------------------------------------------

function upsertTab(tab) {
  if (!tab || tab.id === undefined || tab.id === null) return;
  const id = String(tab.id);
  const next = {
    id,
    type: "page",
    title: tab.title || "",
    url: tab.url || "",
    active: tab.active !== undefined ? !!tab.active : false,
    windowId: tab.windowId,
  };
  const i = tabCache.findIndex((t) => String(t.id) === id);
  if (i >= 0) tabCache[i] = { ...tabCache[i], ...next };
  else tabCache.push(next);
}

function removeTab(id) {
  const sid = String(id);
  tabCache = tabCache.filter((t) => String(t.id) !== sid);
}

// ---------------------------------------------------------------------------
// Management ops (tabs.create / tabs.remove / tabs.activate) -> extension
// ---------------------------------------------------------------------------

function sendManageAndAwait(op, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (!extensionSocket || extensionSocket.readyState !== WebSocket.OPEN) {
      reject(new Error("chrome-bridge: extension not connected"));
      return;
    }
    const timer = setTimeout(() => {
      pendingManage.delete(op.opId);
      reject(new Error("chrome-bridge: manage op timed out"));
    }, timeoutMs);
    pendingManage.set(op.opId, { resolve, reject, timer });
    try {
      extensionSocket.send(JSON.stringify(op));
    } catch (e) {
      clearTimeout(timer);
      pendingManage.delete(op.opId);
      reject(e);
      return;
    }
  });
}

function routeManageReply(msg) {
  const opId = msg && msg.opId;
  if (!opId) return;
  const entry = pendingManage.get(opId);
  if (!entry) return;
  pendingManage.delete(opId);
  clearTimeout(entry.timer);
  if (msg.type === "manage_error") {
    entry.resolve({ type: "error", error: msg.error || { message: "unknown" } });
  } else {
    entry.resolve({ type: "result", tab: msg.tab || null });
  }
}

// Keepalive ping to the extension every 20s (keeps SW alive + detects dead link).
setInterval(() => {
  if (extensionSocket && extensionSocket.readyState === WebSocket.OPEN) {
    // If the extension has not answered a ping in 60s, the socket is a zombie
    // (e.g. Chrome terminated the service worker without a clean close).
    // Terminate it so the next reconnect is accepted instead of rejected.
    if (lastPongAt > 0 && Date.now() - lastPongAt > 60000) {
      try {
        extensionSocket.terminate();
      } catch {}
      return;
    }
    try {
      extensionSocket.send(JSON.stringify({ type: "ping" }));
    } catch {}
  }
}, 20000);

// ---------------------------------------------------------------------------
// Named-pipe transport (optional, no port at all)
// ---------------------------------------------------------------------------
//
// Each pipe connection is a single agent. The framing is intentionally
// simple so any tool can talk to it without a WebSocket library:
//   1 x uint32 BE length prefix
//   N x utf8 bytes of JSON envelope
//
// Envelope shapes:
//   { type: "req", id, method, path, body? }       -> { type: "res", id, status, body }
//   { type: "cdp", id, tabId, method, params? }    -> { type: "cdp_res", id, result|error }
//                                                    + { type: "cdp_evt", tabId, method, params } (zero or more)
//
// The "cdp" path gives the agent CDP over the pipe too, so it never needs
// to open a WebSocket just to drive a tab. A single pipe handles control
// (req/res) and per-tab data (cdp/cdp_res/cdp_evt) multiplexed.

function startPipeServer(pipePath) {
  // Clean up any stale pipe file from a previous run.
  try { fs.unlinkSync(pipePath); } catch {}

  const serverPipe = net.createServer({ allowHalfOpen: false }, (socket) => {
    const agentId = nextConnId++;
    let buf = Buffer.alloc(0);
    let cdpSession = null;

    function send(env) {
      const data = Buffer.from(JSON.stringify(env), "utf8");
      const len = Buffer.alloc(4);
      len.writeUInt32BE(data.length, 0);
      try {
        socket.write(Buffer.concat([len, data]));
      } catch {
        // best-effort: client gone
      }
    }

    function attachCdp(tabId) {
      tabId = String(tabId);
      detachCdp();
      cdpSession = { tabId, cdpId: `pipe-${agentId}-${Date.now()}` };
      if (!pageSockets.has(tabId)) pageSockets.set(tabId, new Set());
      // The set holds "sockets" but for pipe agents it's a tiny shim that
      // knows how to send a CDP event envelope. We tag it isPipe=true so the
      // detach path can find it again.
      const shim = {
        isPipe: true,
        send: (obj) => send({ type: "cdp_evt", tabId, method: obj.method, params: obj.params || {} }),
      };
      pageSockets.get(tabId).add(shim);
      cdpSession.shim = shim;
    }
    function detachCdp() {
      if (!cdpSession) return;
      const set = pageSockets.get(cdpSession.tabId);
      if (set) {
        for (const m of set) if (m.isPipe) set.delete(m);
        if (set.size === 0) pageSockets.delete(cdpSession.tabId);
      }
      cdpSession = null;
    }

    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 4) {
        const len = buf.readUInt32BE(0);
        if (buf.length < 4 + len) break;
        const frame = buf.slice(4, 4 + len).toString("utf8");
        buf = buf.slice(4 + len);
        let env;
        try { env = JSON.parse(frame); } catch { continue; }
        handlePipeEnvelope(env, { agentId, send, attachCdp, detachCdp });
      }
    });

    socket.on("close", () => {
      detachCdp();
      console.log(`[bridge] pipe agent #${agentId} disconnected`);
    });
    socket.on("error", () => {
      try { socket.destroy(); } catch {}
    });
  });

  // One agent at a time over the pipe. The second client gets connected
  // and immediately dropped so callers see ECONNRESET, not a silent stall.
  serverPipe.maxConnections = 1;
  serverPipe.on("connection", (sock) => {
    if (serverPipe.connections && serverPipe.connections.length > 1) {
      try { sock.end(); sock.destroy(); } catch {}
    }
  });

  serverPipe.listen(pipePath, () => {
    console.log(`chrome-bridge pipe listening on ${pipePath}`);
  });
  serverPipe.on("error", (e) => {
    console.error(`[bridge] pipe error: ${e.message}`);
  });
  return serverPipe;
}

// Unix-domain-socket variant for non-Windows (test suites on Linux/macOS).
function startUnixPipeServer(socketPath) {
  try { fs.unlinkSync(socketPath); } catch {}
  const serverPipe = net.createServer({ allowHalfOpen: false }, (socket) => {
    // Reuse the Windows pipe path by adapting the signature: same wire
    // format, same envelope shapes. We just need to keep the file mode
    // tight so only the owner can talk to it.
    let buf = Buffer.alloc(0);
    let cdpSession = null;
    const agentId = nextConnId++;

    function send(env) {
      const data = Buffer.from(JSON.stringify(env), "utf8");
      const len = Buffer.alloc(4);
      len.writeUInt32BE(data.length, 0);
      try { socket.write(Buffer.concat([len, data])); } catch {}
    }
    function attachCdp(tabId) {
      tabId = String(tabId);
      detachCdp();
      cdpSession = { tabId };
      if (!pageSockets.has(tabId)) pageSockets.set(tabId, new Set());
      const shim = {
        isPipe: true,
        send: (obj) => send({ type: "cdp_evt", tabId, method: obj.method, params: obj.params || {} }),
      };
      pageSockets.get(tabId).add(shim);
      cdpSession.shim = shim;
    }
    function detachCdp() {
      if (!cdpSession) return;
      const set = pageSockets.get(cdpSession.tabId);
      if (set) {
        for (const m of set) if (m.isPipe) set.delete(m);
        if (set.size === 0) pageSockets.delete(cdpSession.tabId);
      }
      cdpSession = null;
    }
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 4) {
        const len = buf.readUInt32BE(0);
        if (buf.length < 4 + len) break;
        const frame = buf.slice(4, 4 + len).toString("utf8");
        buf = buf.slice(4 + len);
        let env;
        try { env = JSON.parse(frame); } catch { continue; }
        handlePipeEnvelope(env, { agentId, send, attachCdp, detachCdp });
      }
    });
    socket.on("close", () => detachCdp());
    socket.on("error", () => { try { socket.destroy(); } catch {} });
  });
  serverPipe.maxConnections = 1;
  serverPipe.on("connection", (sock) => {
    if (serverPipe.connections && serverPipe.connections.length > 1) {
      try { sock.end(); sock.destroy(); } catch {}
    }
  });
  serverPipe.listen(socketPath, () => {
    try { fs.chmodSync(socketPath, 0o600); } catch {}
    console.log(`chrome-bridge unix pipe listening on ${socketPath}`);
  });
  serverPipe.on("error", (e) => {
    console.error(`[bridge] unix pipe error: ${e.message}`);
  });
  return serverPipe;
}

async function handlePipeEnvelope(env, ctx) {
  if (!env || typeof env !== "object") return;
  if (env.type === "req") {
    const { id, method, path, body } = env;
    try {
      const pathname = path && path.split("?")[0];
      const out = await handleRequest({ method, pathname, body: body || {} });
      ctx.send({ type: "res", id, status: out.status, body: out.body });
    } catch (e) {
      ctx.send({ type: "res", id, status: 500, body: { error: String((e && e.message) || e) } });
    }
    return;
  }
  if (env.type === "cdp_attach") {
    if (!extensionSocket || extensionSocket.readyState !== WebSocket.OPEN) {
      ctx.send({ type: "res", id: env.id, status: 503, body: { error: "extension not connected" } });
      return;
    }
    if (!Number.isInteger(env.tabId)) {
      ctx.send({ type: "res", id: env.id, status: 400, body: { error: "tabId required" } });
      return;
    }
    ctx.attachCdp(env.tabId);
    ctx.send({ type: "res", id: env.id, status: 200, body: { ok: true, tabId: String(env.tabId) } });
    return;
  }
  if (env.type === "cdp_detach") {
    ctx.detachCdp();
    ctx.send({ type: "res", id: env.id, status: 200, body: { ok: true } });
    return;
  }
  if (env.type === "cdp") {
    if (!extensionSocket || extensionSocket.readyState !== WebSocket.OPEN) {
      ctx.send({ type: "cdp_res", id: env.id, error: { message: "extension not connected" } });
      return;
    }
    const tabId = env.tabId;
    if (!Number.isInteger(tabId)) {
      ctx.send({ type: "cdp_res", id: env.id, error: { message: "tabId required" } });
      return;
    }
    const relayId = `pipe-${ctx.agentId}:${env.id}`;
    pendingByRelayId.set(relayId, {
      socket: { send: (obj) => ctx.send({ type: "cdp_res", id: env.id, ...obj }), isPipe: true },
      tabId: String(tabId),
    });
    const ok = sendToExtension({
      type: "command",
      id: relayId,
      tabId: Number(tabId),
      method: env.method,
      params: env.params || {},
    });
    if (!ok) {
      pendingByRelayId.delete(relayId);
      ctx.send({ type: "cdp_res", id: env.id, error: { message: "extension not connected" } });
    }
    return;
  }
  // Unknown envelope: ignore (forward-compatible).
}

server.listen(PORT, HOST, () => {
  console.log(`chrome-bridge relay listening on http://${HOST}:${PORT}`);
  console.log(`  /json/version  /json/list  /devtools/page/<id>  /json/new  /json/close/<id>  /json/activate/<id>  /self-upgrade  /extension-version  /bridge`);
});

if (PIPE_NAME) {
  // Windows-style pipe path. On non-Windows we still bind to the literal
  // string (Unix domain sockets) so the same env var works for tests on
  // any platform.
  const pipePath = PIPE_NAME.startsWith("\\\\.\\pipe\\")
    ? PIPE_NAME
    : (process.platform === "win32" ? `\\\\.\\pipe\\${PIPE_NAME}` : PIPE_NAME);
  if (process.platform === "win32") {
    startPipeServer(pipePath);
  } else {
    startUnixPipeServer(pipePath);
  }
}