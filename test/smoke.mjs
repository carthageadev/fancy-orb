// smoke.mjs — end-to-end page test in a throwaway headless Chrome.
//
// Spawns its own Chrome instance (isolated temp profile, never your real
// browser), loads the app, and polls the renderer badge until the chosen
// stack comes online — WebGPU or WebGL, depending on adapter availability.
//
// Usage:
//   node test/smoke.mjs                      (expects server on :8124)
//   SMOKE_URL=http://localhost:9000 node test/smoke.mjs
//   CHROME_PATH="C:\path\to\chrome.exe" node test/smoke.mjs

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const url = process.env.SMOKE_URL ?? "http://localhost:8124";
const chromeCandidates = [
  process.env.CHROME_PATH,
  process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe"),
  process.env["PROGRAMFILES(X86)"] && join(process.env["PROGRAMFILES(X86)"], "Google", "Chrome", "Application", "chrome.exe"),
  process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe")
].filter(Boolean);

function findChrome() {
  for (const candidate of chromeCandidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const chrome = findChrome();
if (!chrome) {
  console.log("SKIP: no Chrome executable found (set CHROME_PATH)");
  process.exit(0);
}

const profile = mkdtempSync(join(tmpdir(), "orb-smoke-"));
const args = [
  "--headless=new",
  "--enable-unsafe-webgpu",
  "--enable-unsafe-swiftshader",
  "--use-angle=swiftshader",
  "--no-first-run",
  "--no-default-browser-check",
  "--remote-debugging-port=0",
  `--user-data-dir=${profile}`,
  "--window-size=1280,900"
];

const child = spawn(chrome, args, { windowsHide: true });
child.stderr.on("data", () => {}); // expected GPU chatter; diagnostics come from the page

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function findDebugPort() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const [port] = readFileSync(join(profile, "DevToolsActivePort"), "utf8").trim().split(/\s+/);
      if (port) return port;
    } catch {
      // Chrome still starting
    }
    await sleep(100);
  }
  return null;
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl);
    const pending = new Map();
    let nextId = 1;
    socket.addEventListener("open", () => {
      resolve({
        send(method, params = {}) {
          return new Promise((res, rej) => {
            const id = nextId++;
            pending.set(id, { res, rej });
            socket.send(JSON.stringify({ id, method, params }));
          });
        },
        close() {
          socket.close();
        }
      });
    });
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id && pending.has(message.id)) {
        const { res, rej } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) rej(new Error(message.error.message));
        else res(message.result);
      }
    });
    socket.addEventListener("error", () => reject(new Error("websocket failed")));
  });
}

async function main() {
  const port = await findDebugPort();
  if (!port) {
    console.error("FAIL: Chrome never opened a debug port");
    process.exit(1);
  }

  let page;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
      page = await response.json();
      break;
    } catch {
      await sleep(200);
    }
  }
  if (!page) {
    console.error("FAIL: could not create a page target");
    process.exit(1);
  }

  const client = await connect(page.webSocketDebuggerUrl);
  const deadline = Date.now() + 45000;
  let badge = null;
  while (Date.now() < deadline) {
    await sleep(500);
    try {
      const result = await client.send("Runtime.evaluate", {
        expression: "window.__orbDebug ? window.__orbDebug().badge : null",
        returnByValue: true
      });
      badge = result.result.value;
      if (badge && badge.endsWith("online")) break;
    } catch {
      // page still navigating or frame not ready
    }
  }
  client.close();
  child.kill();

  if (badge && badge.endsWith("online")) {
    console.log(`PASS: renderer online — "${badge}"`);
    process.exit(0);
  }
  console.error(`FAIL: renderer badge not online (got "${badge ?? "none"}")`);
  process.exit(1);
}

main().catch((error) => {
  console.error("FAIL:", error.message);
  process.exit(1);
});

process.on("exit", () => {
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    // best effort — Chrome may still hold the profile at hard exits
  }
});