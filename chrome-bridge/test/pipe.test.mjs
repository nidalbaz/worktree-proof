import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { unlinkSync } from "node:fs";

const PORT = 29333; // test TCP port
const SOCKET = process.platform === "win32"
  ? "\\\\.\\pipe\\chrome-bridge-test"
  : "/tmp/chrome-bridge-test.sock";
const BRIDGE_DIR = fileURLToPath(new URL("..", import.meta.url));

let serverProc = null;
const frame = (env) => {
  const data = Buffer.from(JSON.stringify(env), "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  return Buffer.concat([len, data]);
};
const parseFrames = (buf) => {
  const out = [];
  let b = buf;
  while (b.length >= 4) {
    const len = b.readUInt32BE(0);
    if (b.length < 4 + len) break;
    out.push(JSON.parse(b.slice(4, 4 + len).toString("utf8")));
    b = b.slice(4 + len);
  }
  return { frames: out, rest: b };
};

function startServer() {
  return new Promise((resolve, reject) => {
    try { unlinkSync(SOCKET); } catch {}
    serverProc = spawn(process.execPath, ["server.mjs"], {
      cwd: BRIDGE_DIR,
      env: { ...process.env, CHROME_BRIDGE_PORT: String(PORT), CHROME_BRIDGE_PIPE: SOCKET },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    serverProc.stdout.on("data", (d) => {
      out += d.toString();
      if (out.includes("pipe listening") && out.includes("listening on http")) resolve();
    });
    serverProc.stderr.on("data", (d) => { out += d.toString(); });
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

function pipeConnect() {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(SOCKET, () => resolve(sock));
    sock.on("error", reject);
  });
}

function pipeRequest(sock, env) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const { frames, rest } = parseFrames(buf);
      if (frames.length) {
        sock.off("data", onData);
        resolve(frames[0]);
      }
    };
    sock.on("data", onData);
    sock.on("error", reject);
    sock.write(frame(env));
    setTimeout(() => reject(new Error("pipe request timed out")), 6000);
  });
}

test("pipe: /json/version reports transport=tcp+pipe and the pipe name", async (t) => {
  await startServer();
  t.after(stopServer);
  const sock = await pipeConnect();
  t.after(() => sock.destroy());
  const res = await pipeRequest(sock, { type: "req", id: 1, method: "GET", path: "/json/version" });
  assert.equal(res.status, 200);
  assert.equal(res.body.transport, "tcp+pipe");
  assert.equal(res.body.pipeName, SOCKET);
  assert.match(res.body.Browser, /chrome-bridge/);
});

test("pipe: /json/new opens a tab and /json/list reflects it", async (t) => {
  await startServer();
  t.after(stopServer);
  const ext = await new Promise((resolve, reject) => {
    // Bridge listens on TCP for the extension; the test connects there.
    const s = net.createConnection(PORT, "127.0.0.1", () => resolve(s));
    s.on("error", reject);
  });
  // Upgrade to a real WebSocket manually? Easier: use the ws module
  // imported by the test.
  const { WebSocket } = await import("ws");
  const wsExt = new WebSocket(`ws://127.0.0.1:${PORT}/bridge`);
  await new Promise((r) => wsExt.once("open", r));
  wsExt.on("message", (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.type === "manage" && msg.action === "tabs.create") {
      wsExt.send(
        JSON.stringify({
          type: "manage_result",
          opId: msg.opId,
          tab: { id: "501", title: "Pipe", url: msg.params.url || "about:blank", active: true, windowId: 1 },
        })
      );
    }
  });

  const sock = await pipeConnect();
  t.after(() => sock.destroy());

  const created = await pipeRequest(sock, {
    type: "req",
    id: 10,
    method: "PUT",
    path: "/json/new",
    body: { url: "https://example.com/pipe-test", active: false },
  });
  assert.equal(created.status, 200);
  assert.equal(created.body.id, "501");
  assert.match(created.body.webSocketDebuggerUrl, /\/devtools\/page\/501$/);

  const list = await pipeRequest(sock, { type: "req", id: 11, method: "GET", path: "/json/list" });
  assert.equal(list.status, 200);
  assert.equal(list.body.length, 1);
  assert.equal(list.body[0].id, "501");
  assert.equal(list.body[0].url, "https://example.com/pipe-test");

  wsExt.close();
  ext.destroy();
});

test("pipe: cdp attach + cdp command round-trip over the same pipe", async (t) => {
  await startServer();
  t.after(stopServer);
  const { WebSocket } = await import("ws");
  const wsExt = new WebSocket(`ws://127.0.0.1:${PORT}/bridge`);
  await new Promise((r) => wsExt.once("open", r));
  wsExt.on("message", (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.type === "manage" && msg.action === "tabs.create") {
      wsExt.send(
        JSON.stringify({
          type: "manage_result",
          opId: msg.opId,
          tab: { id: "777", title: "", url: "about:blank", active: true, windowId: 1 },
        })
      );
    } else if (msg.type === "command") {
      wsExt.send(
        JSON.stringify({
          type: "result",
          id: msg.id,
          tabId: msg.tabId,
          result: { result: { type: "number", value: 7 } },
        })
      );
    }
  });

  const sock = await pipeConnect();
  t.after(() => sock.destroy());

  // 1) Open a tab through the pipe.
  const created = await pipeRequest(sock, {
    type: "req", id: 1, method: "PUT", path: "/json/new", body: { url: "about:blank" },
  });
  assert.equal(created.status, 200);
  assert.equal(created.body.id, "777");

  // 2) Attach a CDP session to that tab over the pipe.
  const attach = await pipeRequest(sock, { type: "cdp_attach", id: 2, tabId: 777 });
  assert.equal(attach.status, 200);
  assert.equal(attach.body.ok, true);

  // 3) Send a CDP command; expect a cdp_res with the same id.
  await new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const { frames, rest } = parseFrames(buf);
      for (const f of frames) {
        if (f.type === "cdp_res" && f.id === 3) {
          sock.off("data", onData);
          assert.equal(f.result.result.value, 7);
          resolve();
          return;
        }
      }
    };
    sock.on("data", onData);
    sock.write(frame({ type: "cdp", id: 3, tabId: 777, method: "Runtime.evaluate", params: { expression: "7" } }));
    setTimeout(() => { sock.off("data", onData); reject(new Error("cdp_res timed out")); }, 5000);
  });

  // 4) Detach cleanly.
  const detach = await pipeRequest(sock, { type: "cdp_detach", id: 4 });
  assert.equal(detach.status, 200);
  assert.equal(detach.body.ok, true);

  wsExt.close();
});

test("pipe: second concurrent connection is rejected (one agent at a time)", async (t) => {
  await startServer();
  t.after(stopServer);
  const a = await pipeConnect();
  t.after(() => a.destroy());
  // Second connect should be closed by the server.
  const b = await new Promise((resolve, reject) => {
    const sock = net.createConnection(SOCKET, () => resolve(sock));
    sock.on("error", (e) => resolve({ error: e.code }));
    sock.on("close", () => resolve({ closed: true }));
  });
  // Give the server a moment to close it.
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(b.destroyed || b.closed, "second pipe client should be dropped by the server");
  if (typeof b.end === "function") b.end();
});

test("pipe: /self-upgrade forwards to the extension and returns 202", async (t) => {
  await startServer();
  t.after(stopServer);
  const { WebSocket } = await import("ws");
  const wsExt = new WebSocket(`ws://127.0.0.1:${PORT}/bridge`);
  await new Promise((r) => wsExt.once("open", r));
  let gotSelfUpgrade = false;
  wsExt.on("message", (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.type === "selfUpgrade") gotSelfUpgrade = true;
  });

  const sock = await pipeConnect();
  t.after(() => sock.destroy());
  const res = await pipeRequest(sock, { type: "req", id: 1, method: "POST", path: "/self-upgrade" });
  assert.equal(res.status, 202);
  assert.equal(res.body.accepted, true);
  // The server should have forwarded to the extension.
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(gotSelfUpgrade, true);
  wsExt.close();
});
