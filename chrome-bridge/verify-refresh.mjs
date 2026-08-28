// Verify the chrome-bridge extension has been refreshed to v0.2.0.
// Run this after clicking Stop on the chrome-bridge entry in
// chrome://serviceworker-internals (or after toggling the extension off
// and back on at chrome://extensions).
//
// Usage: node chrome-bridge/verify-refresh.mjs
// Expects the bridge to be running on the named pipe (default) or
// CHROME_BRIDGE_PORT (defaults to 9333).
import net from "node:net";
import http from "node:http";

const PORT = Number(process.env.CHROME_BRIDGE_PORT || 9333);
const PIPE = process.env.CHROME_BRIDGE_PIPE || "";

function getJSON(path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: PORT, path, method: "GET" }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d.toString()));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(body) }); }
        catch { resolve({ status: res.statusCode, body }); }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

function pipeRequest(env) {
  return new Promise((resolve, reject) => {
    const frame = (e) => {
      const d = Buffer.from(JSON.stringify(e), "utf8");
      const l = Buffer.alloc(4);
      l.writeUInt32BE(d.length, 0);
      return Buffer.concat([l, d]);
    };
    const parseFrames = (buf) => {
      const out = []; let b = buf;
      while (b.length >= 4) {
        const l = b.readUInt32BE(0);
        if (b.length < 4 + l) break;
        out.push(JSON.parse(b.slice(4, 4 + l).toString("utf8")));
        b = b.slice(4 + l);
      }
      return out;
    };
    const c = net.createConnection(PIPE.startsWith("\\\\.\\pipe\\") ? PIPE : `\\\\.\\pipe\\${PIPE || "chrome-bridge"}`);
    c.once("error", reject);
    let buf = Buffer.alloc(0);
    c.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (const f of parseFrames(buf)) { buf = Buffer.alloc(0); resolve(f); return; }
    });
    c.write(frame(env));
    setTimeout(() => reject(new Error("pipe timeout")), 5000);
  });
}

async function checkOverPipe() {
  const r = await pipeRequest({ type: "req", id: 1, method: "GET", path: "/extension-version" });
  return { transport: "pipe", status: r.status, body: r.body };
}

async function checkOverHttp() {
  const r = await getJSON("/extension-version");
  return { transport: "http", ...r };
}

console.log("chrome-bridge refresh verification");
console.log("----------------------------------");
console.log("If extensionVersion reports 'unknown' the running SW is still");
console.log("v0.1.0. After clicking Stop on the chrome-bridge entry in");
console.log("chrome://serviceworker-internals, the next alarm tick re-spawns");
console.log("the SW from the on-disk v0.2.0 and the version flips to 0.2.0.");
console.log("");

let result;
if (PIPE) {
  try { result = await checkOverPipe(); }
  catch (e) { console.log("pipe probe failed:", e.message); result = await checkOverHttp(); }
} else {
  result = await checkOverHttp();
}

console.log("transport:", result.transport);
console.log("status:   ", result.status);
console.log("loaded:   ", result.body.extensionVersion);
console.log("on-disk:  ", result.body.manifestVersion);
console.log("");

if (result.body.extensionVersion === result.body.manifestVersion) {
  console.log("OK: running extension matches on-disk manifest.");
  console.log("    tab management (PUT /json/new, etc.) is live.");
  process.exit(0);
} else {
  console.log("WAITING: extension is still on " + result.body.extensionVersion + ".");
  console.log("         Click Stop on the chrome-bridge SW entry in");
  console.log("         chrome://serviceworker-internals, then re-run this script.");
  process.exit(1);
}
