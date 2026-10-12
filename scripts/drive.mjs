// Drives the will-terminal test window (scripts/run-debug.mjs) through the WebView2 debugging port (CDP).
// Usage, from the repo root: node scripts/drive.mjs <step> <step> ...
//   prefix | enter | esc | tab | type:<text> | key:<char> | ctrl:<k> | ctrlshift:<k> | arrow:<Left|Right|Up|Down>
//   wait:<ms> | shot:<name> | eval:<js> | click:<x>,<y> | dbl:<x>,<y> | rclick:<x>,<y>
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const PORT = 9223;
// screenshots go next to the test build, which git ignores
const SHOTS = path.resolve("src-tauri/target/test/shots");
mkdirSync(SHOTS, { recursive: true });

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const page = targets.find((t) => t.type === "page" && !t.url.includes("splashscreen"));
if (!page) throw new Error("main page not found: " + JSON.stringify(targets.map((t) => t.url)));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
let seq = 0;
const pending = new Map();
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
};
const send = (method, params = {}) =>
  new Promise((r) => {
    const id = ++seq;
    pending.set(id, r);
    ws.send(JSON.stringify({ id, method, params }));
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// char -> [code, vk, shift]
const SPECIAL = {
  "%": ["Digit5", 53, 1], '"': ["Quote", 222, 1], "'": ["Quote", 222, 0], "{": ["BracketLeft", 219, 1], "}": ["BracketRight", 221, 1],
  "[": ["BracketLeft", 219, 0], "]": ["BracketRight", 221, 0], ":": ["Semicolon", 186, 1], ";": ["Semicolon", 186, 0],
  "?": ["Slash", 191, 1], "/": ["Slash", 191, 0], "&": ["Digit7", 55, 1], "=": ["Equal", 187, 0], "+": ["Equal", 187, 1],
  "-": ["Minus", 189, 0], ",": ["Comma", 188, 0], ".": ["Period", 190, 0], " ": ["Space", 32, 0],
};
function keyInfo(ch) {
  if (SPECIAL[ch]) return { code: SPECIAL[ch][0], vk: SPECIAL[ch][1], shift: SPECIAL[ch][2] };
  if (/[a-z]/.test(ch)) return { code: "Key" + ch.toUpperCase(), vk: ch.toUpperCase().charCodeAt(0), shift: 0 };
  if (/[A-Z]/.test(ch)) return { code: "Key" + ch, vk: ch.charCodeAt(0), shift: 1 };
  if (/[0-9]/.test(ch)) return { code: "Digit" + ch, vk: ch.charCodeAt(0), shift: 0 };
  throw new Error("no key for " + ch);
}
async function press({ key, code, vk, mods = 0, text }) {
  await send("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", key, code, windowsVirtualKeyCode: vk, modifiers: mods, text, unmodifiedText: text });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: vk, modifiers: mods });
  await sleep(60);
}
const pressChar = (ch, extraMods = 0) => {
  const k = keyInfo(ch);
  const mods = extraMods | (k.shift ? 8 : 0);
  return press({ key: ch, code: k.code, vk: k.vk, mods, text: extraMods & 2 ? undefined : ch });
};
async function mouse(x, y, button = "left", clickCount = 1) {
  for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x, y, button, clickCount });
  await sleep(80);
}

for (const step of process.argv.slice(2)) {
  const [cmd, ...rest] = step.split(":");
  const arg = rest.join(":");
  if (cmd === "prefix") await pressChar("b", 2);
  else if (cmd === "enter") await press({ key: "Enter", code: "Enter", vk: 13, text: "\r" });
  else if (cmd === "esc") await press({ key: "Escape", code: "Escape", vk: 27 });
  else if (cmd === "tab") await press({ key: "Tab", code: "Tab", vk: 9, text: "\t" });
  else if (cmd === "type") {
    await send("Input.insertText", { text: arg });
    await sleep(80);
  } else if (cmd === "key") await pressChar(arg);
  else if (cmd === "ctrl") await pressChar(arg, 2);
  else if (cmd === "ctrlshift") await pressChar(arg.toLowerCase(), 2 | 8);
  else if (cmd === "arrow") await press({ key: "Arrow" + arg, code: "Arrow" + arg, vk: { Left: 37, Up: 38, Right: 39, Down: 40 }[arg] });
  else if (cmd === "wait") await sleep(Number(arg));
  else if (cmd === "click" || cmd === "dbl" || cmd === "rclick") {
    const [x, y] = arg.split(",").map(Number);
    if (cmd === "dbl") {
      await mouse(x, y, "left", 1);
      await mouse(x, y, "left", 2);
    } else await mouse(x, y, cmd === "rclick" ? "right" : "left");
  } else if (cmd === "shot") {
    const r = await send("Page.captureScreenshot", { format: "png" });
    const file = path.join(SHOTS, `${arg}.png`);
    writeFileSync(file, Buffer.from(r.result.data, "base64"));
    console.log("shot", file);
  } else if (cmd === "eval") {
    const r = await send("Runtime.evaluate", { expression: arg, awaitPromise: true, returnByValue: true });
    console.log("eval", JSON.stringify(r.result.result?.value ?? r.result.exceptionDetails?.text ?? r.result));
  } else throw new Error("unknown step " + step);
}
ws.close();
