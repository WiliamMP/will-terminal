// Starts a test copy of the app that scripts/drive.mjs can control:
// - WebView2 debugging port 9223 (Tauri ignores WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS, so it goes in the window config)
// - identifier ".test": its own data (layout, profiles, logs) and its own single instance, apart from the real app
// - Vite on 1430 and builds in src-tauri/target/test, so it runs next to a `npm run tauri dev` already open
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const dir = path.resolve("src-tauri/target/test");
mkdirSync(dir, { recursive: true });
const conf = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
const config = path.join(dir, "tauri.test.json");
writeFileSync(
  config,
  JSON.stringify({
    identifier: `${conf.identifier}.test`,
    build: { devUrl: "http://localhost:1430", beforeDevCommand: "" },
    app: { windows: conf.app.windows.map((w) => ({ ...w, additionalBrowserArgs: "--remote-debugging-port=9223" })) },
  }),
);

const run = (cmd, env = {}) => spawn(cmd, { shell: true, stdio: "inherit", env: { ...process.env, ...env } });
const vite = run("npx vite --port 1430 --strictPort");
const app = run(`npx tauri dev --config "${config}"`, { CARGO_TARGET_DIR: dir });
// closing the app ends the test session; taskkill /T, because kill() would only end the shell around Vite
app.on("exit", (code) => {
  spawn("taskkill", ["/pid", String(vite.pid), "/T", "/F"], { stdio: "ignore" }).on("exit", () => process.exit(code ?? 0));
});
