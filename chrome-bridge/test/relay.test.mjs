import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const PORT = 19333; // test port
let serverProc = null;
const BRIDGE_DIR = fileURLToPath(new URL("..", import.meta.url));

function startServer() {
  return new Promise((resolve, reject) => {
    serverProc = spawn(process.execPath, ["server.mjs"], {
      cwd: BRIDGE_DIR,
      env: { ...process.env, CHROME_BRIDGE_PORT: String(PORT) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    serverProc.stdout.on("data", (d) => {
      out += d.toString();
      if (out.includes("listening")) resolve();
    });
    serverProc.stderr.on("data", (d) => {
      out += d.toString();
    });
    setTimeout(() => reject(new Error("server did not start: " + out)), 8000);
  });
}

function stopServer() {
  return new Promise((resolve) => {
    if (!serverProc) return resolve();
    serverProc.on("exit", () => resolve());
    serverProc.kill();
    setTimeout(resolve, 1500);
  });
}

function getJson(path) {
  return new Promise((resolve, reject) => {
    http
      .get(`http://127.0.0.1:${PORT}${path}`, (res) => {
        let body = "";
        res.on("data", (d) => (body += d.toString()));
        res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
      })
      .on("error", reject);
  });
}

function openWs(path) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}${path}`);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

test("relay: /json/version and /json/list before extension", async (t) => {
  await startServer();
  t.after(stopServer);
  const v = await getJson("/json/version");
  assert.equal(v.status, 200);
  assert.match(v.body.Browser, /chrome-bridge/);
  const l = await getJson("/json/list");
  assert.equal(l.status, 200);
  assert.deepEqual(l.body, []);
});

test("relay: extension uplink pushes tabs and command round-trips", async (t) => {
  await startServer();
  t.after(stopServer);

  // Simulate the extension: connect to /bridge, push tabs, answer commands.
  const ext = await openWs("/bridge");
  ext.send(
    JSON.stringify({
      type: "tabs",
      tabs: [{ id: "7", type: "page", title: "Test", url: "https://example.com", active: true }],
    })
  );
  await new Promise((r) => setTimeout(r, 200));

  const l = await getJson("/json/list");
  assert.equal(l.body.length, 1);
  assert.equal(l.body[0].id, "7");
  assert.equal(l.body[0].title, "Test");
  assert.equal(l.body[0].url, "https://example.com");

  // Agent connects to the page target and sends a CDP command.
  const agent = await openWs(`/devtools/page/7`);
  const cmdPromise = new Promise((resolve) => {
    agent.on("message", (data) => resolve(JSON.parse(data.toString())));
  });
  agent.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: "1+1" } }));

  // Extension receives the command and replies.
  const cmdFromRelay = await new Promise((resolve) => {
    ext.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === "command") resolve(msg);
    });
  });
  assert.equal(cmdFromRelay.tabId, 7);
  assert.equal(cmdFromRelay.method, "Runtime.evaluate");
  ext.send(
    JSON.stringify({
      type: "result",
      id: cmdFromRelay.id,
      tabId: 7,
      result: { result: { type: "number", value: 2 } },
    })
  );

  const reply = await cmdPromise;
  assert.equal(reply.id, 1);
  assert.equal(reply.result.result.value, 2);

  // Event fan-out to the agent.
  const eventPromise = new Promise((resolve) => {
    agent.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.method) resolve(msg);
    });
  });
  ext.send(JSON.stringify({ type: "event", tabId: 7, method: "Page.loadEventFired", params: { t: 1 } }));
  const ev = await eventPromise;
  assert.equal(ev.method, "Page.loadEventFired");

  agent.close();
  ext.close();
});

test("relay: command with no extension returns error to agent", async (t) => {
  await startServer();
  t.after(stopServer);
  // No extension connected; push a tab cache manually is impossible without
  // extension, so connect agent to a fake tab id and expect error response.
  const agent = await openWs(`/devtools/page/99`);
  const replyPromise = new Promise((resolve) => {
    agent.on("message", (data) => resolve(JSON.parse(data.toString())));
  });
  agent.send(JSON.stringify({ id: 5, method: "Runtime.evaluate", params: {} }));
  const reply = await replyPromise;
  assert.equal(reply.id, 5);
  assert.match(reply.error.message, /extension not connected/);
  agent.close();
});

// ---------------------------------------------------------------------------
// Tab management: PUT /json/new, PUT /json/close/<id>, GET /json/activate/<id>
// ---------------------------------------------------------------------------

function httpRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request(
      {
        host: "127.0.0.1",
        port: PORT,
        method,
        path,
        headers: data
          ? { "Content-Type": "application/json", "Content-Length": data.length }
          : {},
      },
      (res) => {
        let buf = "";
        res.on("data", (d) => (buf += d.toString()));
        res.on("end", () => {
          let parsed = null;
          try {
            parsed = JSON.parse(buf);
          } catch {
            parsed = buf;
          }
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

test("relay: PUT /json/new opens a tab via the extension and adds it to /json/list", async (t) => {
  await startServer();
  t.after(stopServer);
  const ext = await openWs("/bridge");
  // The extension replies to a `manage` op with the new tab payload.
  ext.on("message", (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.type === "manage" && msg.action === "tabs.create") {
      ext.send(
        JSON.stringify({
          type: "manage_result",
          opId: msg.opId,
          tab: {
            id: "101",
            title: "",
            url: msg.params.url || "chrome://newtab/",
            active: msg.params.active !== false,
            windowId: 1,
          },
        })
      );
    } else if (msg.type === "manage" && msg.action === "tabs.activate") {
      ext.send(
        JSON.stringify({
          type: "manage_result",
          opId: msg.opId,
          tab: { id: String(msg.params.tabId), active: true, title: "", url: "" },
        })
      );
    } else if (msg.type === "manage" && msg.action === "tabs.remove") {
      ext.send(JSON.stringify({ type: "manage_result", opId: msg.opId, tab: { id: String(msg.params.tabId) } }));
    }
  });

  const created = await httpRequest("PUT", "/json/new", { url: "https://example.com/new", active: true });
  assert.equal(created.status, 200);
  assert.equal(created.body.id, "101");
  assert.equal(created.body.type, "page");
  assert.match(created.body.webSocketDebuggerUrl, /\/devtools\/page\/101$/);

  // /json/list should immediately reflect the new tab.
  const list = await getJson("/json/list");
  assert.equal(list.body.length, 1);
  assert.equal(list.body[0].id, "101");
  assert.equal(list.body[0].url, "https://example.com/new");
  // The standard CDP /json/list shape (id/type/title/url/webSocketDebuggerUrl)
  // is what Codex/Claude/Puppeteer consume. active/windowId live in the
  // tab cache (used internally) but are not part of the wire format.

  // GET /json/activate/101 -> success
  const act = await httpRequest("GET", "/json/activate/101");
  assert.equal(act.status, 200);
  assert.deepEqual(act.body, { success: true });

  // PUT /json/close/101 -> success and removes it from /json/list
  const close = await httpRequest("PUT", "/json/close/101");
  assert.equal(close.status, 200);
  assert.deepEqual(close.body, { success: true });
  const after = await getJson("/json/list");
  assert.deepEqual(after.body, []);

  ext.close();
});

test("relay: PUT /json/new returns 503 when extension is not connected", async (t) => {
  await startServer();
  t.after(stopServer);
  const r = await httpRequest("PUT", "/json/new", { url: "about:blank" });
  assert.equal(r.status, 503);
  assert.match(r.body.error, /extension not connected/);
});

test("relay: PUT /json/new returns 502 when extension reports error", async (t) => {
  await startServer();
  t.after(stopServer);
  const ext = await openWs("/bridge");
  ext.on("message", (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.type === "manage" && msg.action === "tabs.create") {
      ext.send(
        JSON.stringify({
          type: "manage_error",
          opId: msg.opId,
          error: { message: "Tabs cannot be edited right now" },
        })
      );
    }
  });
  const r = await httpRequest("PUT", "/json/new", { url: "https://blocked.example/" });
  assert.equal(r.status, 502);
  assert.match(r.body.error, /Tabs cannot be edited/);
  ext.close();
});

test("relay: PUT /json/new with no body still opens a tab (defaults to active=true)", async (t) => {
  await startServer();
  t.after(stopServer);
  const ext = await openWs("/bridge");
  let received = null;
  ext.on("message", (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.type === "manage" && msg.action === "tabs.create") {
      received = msg.params;
      ext.send(
        JSON.stringify({
          type: "manage_result",
          opId: msg.opId,
          tab: { id: "202", title: "", url: "chrome://newtab/", active: true, windowId: 1 },
        })
      );
    }
  });
  const r = await httpRequest("PUT", "/json/new", undefined);
  assert.equal(r.status, 200);
  assert.equal(r.body.id, "202");
  assert.equal(received.active, true);
  assert.equal(received.url, undefined);
  ext.close();
});