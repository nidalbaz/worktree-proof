import { tool } from "@opencode-ai/plugin";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import net from "node:net";
import { Button, Key, getActiveWindow, getWindows, keyboard, mouse } from "@nut-tree-fork/nut-js";
import screenshotDesktop from "screenshot-desktop";

const keyMap = {
  ctrl: Key.LeftControl, control: Key.LeftControl, alt: Key.LeftAlt, option: Key.LeftAlt,
  shift: Key.LeftShift, win: Key.LeftMeta, meta: Key.LeftMeta, cmd: Key.LeftMeta,
  enter: Key.Enter, return: Key.Enter, tab: Key.Tab, space: Key.Space, esc: Key.Escape,
  escape: Key.Escape, up: Key.Up, down: Key.Down, left: Key.Left, right: Key.Right,
  home: Key.Home, end: Key.End, pageup: Key.PageUp, pagedown: Key.PageDown,
  insert: Key.Insert, delete: Key.Delete, backspace: Key.Backspace,
  f1: Key.F1, f2: Key.F2, f3: Key.F3, f4: Key.F4, f5: Key.F5, f6: Key.F6,
  f7: Key.F7, f8: Key.F8, f9: Key.F9, f10: Key.F10, f11: Key.F11, f12: Key.F12,
};

function parseKeys(combo) {
  return combo.split("+").map((part) => keyMap[part.trim().toLowerCase()] ?? part.trim());
}

function result(title, value) {
  return { title, output: typeof value === "string" ? value : JSON.stringify(value, null, 2) };
}

// ---------------------------------------------------------------------------
// Chrome Bridge integration (no-port IPC to the chrome-bridge relay)
// ---------------------------------------------------------------------------
//
// The user's main Chrome is driven through a tiny bridge relay that the
// chrome-bridge extension runs alongside. The relay exposes the same
// CDP-compatible endpoints over two transports:
//
//   * TCP loopback on 127.0.0.1:9333 (default)
//   * Windows named pipe \\\\.\pipe\chrome-bridge (zero port, like
//     ChatGPT/Claude desktop)
//
// We prefer the pipe when available because it leaves no port number for
// the OS to advertise. The pipe protocol is a length-prefixed JSON
// envelope (uint32 BE length + utf8 JSON). One agent at a time; the
// second client is dropped immediately.

const BRIDGE_TCP = process.env.CHROME_BRIDGE_PORT
  ? `http://127.0.0.1:${process.env.CHROME_BRIDGE_PORT}`
  : "http://127.0.0.1:9333";
const BRIDGE_PIPE = process.env.CHROME_BRIDGE_PIPE || "chrome-bridge";
const BRIDGE_PIPE_PATH = `\\\\.\\pipe\\${BRIDGE_PIPE}`;
const BRIDGE_TIMEOUT_MS = 8000;

function bridgeFrame(env) {
  const data = Buffer.from(JSON.stringify(env), "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  return Buffer.concat([len, data]);
}

function parseFrames(buf) {
  const out = [];
  let b = buf;
  while (b.length >= 4) {
    const l = b.readUInt32BE(0);
    if (b.length < 4 + l) break;
    out.push(JSON.parse(b.slice(4, 4 + l).toString("utf8")));
    b = b.slice(4 + l);
  }
  return out;
}

function bridgeRequestPipe(env) {
  return new Promise((resolveRequest, reject) => {
    let socket;
    try {
      socket = net.createConnection(BRIDGE_PIPE_PATH);
    } catch (e) {
      reject(e);
      return;
    }
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => {
      try { socket.destroy(); } catch {}
      reject(new Error("bridge pipe timeout"));
    }, BRIDGE_TIMEOUT_MS);
    socket.once("error", (e) => { clearTimeout(timer); reject(e); });
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (const f of parseFrames(buf)) {
        clearTimeout(timer);
        try { socket.destroy(); } catch {}
        resolveRequest(f);
        return;
      }
    });
    socket.write(bridgeFrame(env));
  });
}

async function bridgeRequestHttp(env) {
  const url = `${BRIDGE_TCP}${env.path || "/json/version"}`;
  const init = { method: env.method || "GET", headers: { "Content-Type": "application/json" } };
  if (env.body !== undefined) init.body = JSON.stringify(env.body);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), BRIDGE_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: ctrl.signal });
    const body = await response.json();
    return { type: "res", id: env.id || 0, status: response.status, body };
  } finally {
    clearTimeout(timer);
  }
}

async function bridgeRequest(env) {
  if (process.platform === "win32") {
    try { return await bridgeRequestPipe(env); }
    catch { /* fall through to HTTP */ }
  }
  return bridgeRequestHttp(env);
}

async function bridgeCdpAttach(tabId) {
  return bridgeRequest({ type: "cdp_attach", id: 1, tabId });
}

async function bridgeCdp(tabId, method, params) {
  return bridgeRequest({ type: "cdp", id: 2, tabId, method, params });
}

async function bridgeTabs() {
  const r = await bridgeRequest({ type: "req", id: 1, method: "GET", path: "/json/list" });
  return r.body || [];
}

async function bridgeVersion() {
  const r = await bridgeRequest({ type: "req", id: 1, method: "GET", path: "/extension-version" });
  return r.body || {};
}

const computerTools = {
  computer_screenshot: tool({
    description: "Capture the physical desktop. This is OS-level automation; review the image before acting on sensitive UI.",
    args: { savePath: tool.schema.string().optional(), format: tool.schema.enum(["png", "jpg"]).optional() },
    async execute(args, context) {
      const format = args.format || "png";
      const bytes = await screenshotDesktop({ format });
      let saved;
      if (args.savePath) {
        saved = resolve(context.worktree, args.savePath);
        await writeFile(saved, bytes);
      }
      const mime = format === "jpg" ? "image/jpeg" : "image/png";
      return { title: "Computer screenshot", output: saved ? `Saved to ${saved}` : "Desktop screenshot captured", attachments: [{ type: "file", mime, url: `data:${mime};base64,${bytes.toString("base64")}`, filename: `computer-screenshot.${format}` }] };
    },
  }),
  computer_mouse_move: tool({
    description: "Move the physical mouse to screen coordinates.",
    args: { x: tool.schema.number().int().min(0), y: tool.schema.number().int().min(0) },
    async execute(args) { await mouse.move([{ x: args.x, y: args.y }]); return result("Computer mouse move", args); },
  }),
  computer_mouse_click: tool({
    description: "Click the physical mouse at screen coordinates.",
    args: { x: tool.schema.number().int().min(0).optional(), y: tool.schema.number().int().min(0).optional(), button: tool.schema.enum(["left", "right", "middle"]).optional(), count: tool.schema.number().int().min(1).max(2).optional() },
    async execute(args) {
      if (args.x !== undefined && args.y !== undefined) await mouse.move([{ x: args.x, y: args.y }]);
      const button = args.button === "right" ? Button.RIGHT : args.button === "middle" ? Button.MIDDLE : Button.LEFT;
      for (let index = 0; index < (args.count || 1); index += 1) await mouse.click(button);
      return result("Computer mouse click", { button: args.button || "left", count: args.count || 1, x: args.x, y: args.y });
    },
  }),
  computer_mouse_drag: tool({
    description: "Drag the physical mouse between two screen coordinates.",
    args: { fromX: tool.schema.number().int().min(0), fromY: tool.schema.number().int().min(0), toX: tool.schema.number().int().min(0), toY: tool.schema.number().int().min(0) },
    async execute(args) { await mouse.move([{ x: args.fromX, y: args.y }]); await mouse.drag([{ x: args.toX, y: args.toY }]); return result("Computer mouse drag", args); },
  }),
  computer_mouse_scroll: tool({
    description: "Scroll the physical mouse wheel.",
    args: { delta: tool.schema.number().int().min(-10000).max(10000), x: tool.schema.number().int().min(0).optional(), y: tool.schema.number().int().min(0).optional() },
    async execute(args) { if (args.x !== undefined && args.y !== undefined) await mouse.move([{ x: args.x, y: args.y }]); await mouse.scroll(args.delta); return result("Computer mouse scroll", args); },
  }),
  computer_keyboard_type: tool({
    description: "Type text into the focused desktop application. Do not use for passwords, OTPs, or other secrets.",
    args: { text: tool.schema.string() },
    async execute(args) { await keyboard.type(args.text); return result("Computer keyboard type", { characters: args.text.length }); },
  }),
  computer_keyboard_press: tool({
    description: "Press a key or key combination such as ctrl+c, alt+tab, or enter.",
    args: { combo: tool.schema.string() },
    async execute(args) { await keyboard.pressKey(...parseKeys(args.combo)); return result("Computer keyboard press", { combo: args.combo }); },
  }),
  computer_window_list: tool({
    description: "List visible desktop windows with titles and bounds.",
    args: {},
    async execute() {
      const windows = await getWindows();
      const data = [];
      for (const window of windows) {
        const region = await window.getRegion().catch(() => null);
        data.push({ title: await window.getTitle().catch(() => ""), region });
      }
      return result("Computer windows", data);
    },
  }),
  computer_window_focus: tool({
    description: "Focus a desktop window by case-insensitive title substring.",
    args: { title: tool.schema.string() },
    async execute(args) {
      const windows = await getWindows();
      const window = (await Promise.all(windows.map(async (candidate) => ({ candidate, title: await candidate.getTitle().catch(() => "") })))).find((item) => item.title.toLowerCase().includes(args.title.toLowerCase()))?.candidate;
      if (!window) throw new Error(`Window not found: ${args.title}`);
      await window.focus();
      return result("Computer window focused", { title: await window.getTitle() });
    },
  }),
  computer_window_bounds: tool({
    description: "Read or update a desktop window's position and size by title substring.",
    args: { title: tool.schema.string(), action: tool.schema.enum(["get", "set"]).optional(), x: tool.schema.number().int().min(0).optional(), y: tool.schema.number().int().min(0).optional(), width: tool.schema.number().int().min(1).optional(), height: tool.schema.number().int().min(1).optional() },
    async execute(args) {
      const windows = await getWindows();
      const window = (await Promise.all(windows.map(async (candidate) => ({ candidate, title: await candidate.getTitle().catch(() => "") })))).find((item) => item.title.toLowerCase().includes(args.title.toLowerCase()))?.candidate;
      if (!window) throw new Error(`Window not found: ${args.title}`);
      if ((args.action || "get") === "set") {
        if (args.x !== undefined && args.y !== undefined) await window.move({ x: args.x, y: args.y });
        if (args.width !== undefined && args.height !== undefined) await window.resize({ width: args.width, height: args.height });
      }
      return result("Computer window bounds", { title: await window.getTitle(), region: await window.getRegion() });
    },
  }),
  computer_active_window: tool({
    description: "Read the active desktop window title and bounds.",
    args: {},
    async execute() { const window = await getActiveWindow(); return result("Computer active window", { title: await window.getTitle(), region: await window.getRegion() }); },
  }),
  computer_wait: tool({
    description: "Wait for a bounded number of milliseconds while a GUI changes.",
    args: { milliseconds: tool.schema.number().int().min(0).max(120000) },
    async execute(args) { await new Promise((resolvePromise) => setTimeout(resolvePromise, args.milliseconds)); return result("Computer wait", args); },
  }),

  // ---------------------------------------------------------------------------
  // Chrome Bridge awareness (browser content via CDP, no focus-fighting)
  // ---------------------------------------------------------------------------
  //
  // These tools let the agent reason about the browser without
  // fighting focus or screen coordinates: list the user's real Chrome
  // tabs, evaluate JS in them, take CDP screenshots, activate or
  // close tabs, open new ones. Use them whenever the target is a
  // browser page; fall back to the OS-level computer_* tools for the
  // browser chrome (URL bar, tabs strip, settings) or for non-browser
  // desktop apps.

  computer_browser_tabs: tool({
    description: "List the user's normal Chrome tabs via the chrome-bridge relay. No-port IPC over the named pipe \\\\\\\\.\\\\pipe\\\\chrome-bridge when available, falling back to http://127.0.0.1:9333. Returned ids can be used with computer_browser_evaluate and computer_browser_activate.",
    args: { urlContains: tool.schema.string().optional().describe("Filter: only return tabs whose URL contains this substring"), titleContains: tool.schema.string().optional().describe("Filter: only return tabs whose title contains this substring") },
    async execute(args) {
      const all = await bridgeTabs();
      const filtered = all.filter((t) => {
        if (args.urlContains && !(t.url || "").includes(args.urlContains)) return false;
        if (args.titleContains && !(t.title || "").includes(args.titleContains)) return false;
        return true;
      });
      return result("Browser tabs", filtered.map((t) => ({ id: t.id, title: t.title, url: t.url, type: t.type })));
    },
  }),
  computer_browser_activate: tool({
    description: "Focus a Chrome tab by id (the same id returned by computer_browser_tabs or /json/list) using the bridge. The tab comes to the foreground, which is usually enough for the user to see it without further window management.",
    args: { tabId: tool.schema.string().describe("Chrome tab id from computer_browser_tabs") },
    async execute(args) {
      const r = await bridgeRequest({ type: "req", id: 1, method: "GET", path: `/json/activate/${encodeURIComponent(args.tabId)}` });
      if (r.status !== 200) throw new Error(`activate failed: ${r.body?.error || r.status}`);
      return result("Browser tab activated", { id: args.tabId, status: r.status });
    },
  }),
  computer_browser_open: tool({
    description: "Open a new tab in the user's main Chrome via the bridge. Returns the new tab id, which can be used with computer_browser_evaluate.",
    args: { url: tool.schema.string().url().optional(), active: tool.schema.boolean().optional() },
    async execute(args) {
      const r = await bridgeRequest({ type: "req", id: 1, method: "PUT", path: "/json/new", body: { url: args.url, active: args.active } });
      if (r.status !== 200) throw new Error(`open failed: ${r.body?.error || r.status}`);
      return result("Browser tab opened", { id: r.body.id, url: r.body.url });
    },
  }),
  computer_browser_close: tool({
    description: "Close a Chrome tab by id via the bridge.",
    args: { tabId: tool.schema.string().describe("Chrome tab id from computer_browser_tabs") },
    async execute(args) {
      const r = await bridgeRequest({ type: "req", id: 1, method: "PUT", path: `/json/close/${encodeURIComponent(args.tabId)}` });
      if (r.status !== 200) throw new Error(`close failed: ${r.body?.error || r.status}`);
      return result("Browser tab closed", { id: args.tabId });
    },
  }),
  computer_browser_evaluate: tool({
    description: "Evaluate JavaScript in a Chrome tab via the bridge (CDP Runtime.evaluate). Faster and more reliable than mouse coordinates for in-page actions. Never use to inspect cookies, storage, or other sensitive state without the user's explicit ask.",
    args: { tabId: tool.schema.string().describe("Chrome tab id from computer_browser_tabs"), expression: tool.schema.string().describe("JavaScript to evaluate in the page context") },
    async execute(args) {
      await bridgeCdpAttach(args.tabId);
      const r = await bridgeCdp(args.tabId, "Runtime.evaluate", { expression: args.expression, returnByValue: true, awaitPromise: true });
      if (r.error) throw new Error(`evaluate failed: ${r.error.message || JSON.stringify(r.error)}`);
      return result("Browser evaluate", { tabId: args.tabId, value: r.result?.value, type: r.result?.type });
    },
  }),
  computer_browser_screenshot: tool({
    description: "Capture a Chrome tab's contents via the bridge (CDP Page.captureScreenshot). Returns the page only, not the browser chrome. Use computer_screenshot when you need the browser window decoration too.",
    args: { tabId: tool.schema.string().describe("Chrome tab id from computer_browser_tabs"), savePath: tool.schema.string().optional(), fullPage: tool.schema.boolean().optional() },
    async execute(args, context) {
      await bridgeCdpAttach(args.tabId);
      const r = await bridgeCdp(args.tabId, "Page.captureScreenshot", { format: "png", captureBeyondViewport: Boolean(args.fullPage) });
      if (r.error) throw new Error(`screenshot failed: ${r.error.message || JSON.stringify(r.error)}`);
      let saved;
      if (args.savePath) {
        saved = resolve(context.worktree, args.savePath);
        await writeFile(saved, Buffer.from(r.data, "base64"));
      }
      return { title: "Browser screenshot", output: saved ? `Saved to ${saved}` : `tabId=${args.tabId}`, attachments: [{ type: "file", mime: "image/png", url: `data:image/png;base64,${r.data}`, filename: "browser-screenshot.png" }] };
    },
  }),
  computer_browser_bridge_status: tool({
    description: "Check the chrome-bridge relay status: which transport is in use (named pipe or TCP), and the loaded extension version. Use this first when a computer_browser_* tool fails, to confirm the bridge is reachable.",
    args: {},
    async execute() {
      let version, transport, error;
      try { version = await bridgeVersion(); }
      catch (e) { error = e.message; }
      try { const v = await bridgeRequest({ type: "req", id: 1, method: "GET", path: "/json/version" }); transport = v.body; }
      catch (e) { if (!error) error = e.message; }
      return result("Browser bridge status", { transport, extensionVersion: version, error });
    },
  }),
};

export const ComputerUsePlugin = async () => ({ tool: computerTools });
