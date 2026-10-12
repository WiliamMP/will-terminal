---
name: run-will-terminal
description: Launch the will-terminal app in a test copy and drive it (keys, mouse, screenshots) through the WebView2 debugging port. Use to see a change working in the real app.
---

# Run and drive will-terminal

The app is Tauri 2 (WebView2). A test copy opens with a CDP debugging port and is driven by a small script; it uses its own identifier (`com.wiliammp.will-terminal.test`), port and build folder, so it does not touch an instance the user has open.

## Launch

```bash
node scripts/run-debug.mjs   # run in the background; first build takes ~1-2 min
# ready when this lists the page:
curl -s http://127.0.0.1:9223/json | grep localhost:1430
```

## Drive

From the repo root, one call runs a sequence of steps and prints where each screenshot went (`src-tauri/target/test/shots/<name>.png`). **Read the screenshots** — a blank pane is a failure.

```bash
node scripts/drive.mjs type:"dir" enter wait:1500 prefix key:% wait:2000 shot:split
```

Steps: `prefix` (Ctrl+B) · `enter` · `esc` · `tab` · `type:<text>` · `key:<char>` (`%`, `"`, `{`, `?`, letters, digits; uppercase = Shift) · `ctrl:<k>` · `ctrlshift:<k>` (`ctrlshift:P` palette, `ctrlshift:F` search) · `arrow:<Left|Right|Up|Down>` · `wait:<ms>` · `shot:<name>` · `eval:<js>` · `click:<x>,<y>` · `dbl:<x>,<y>` · `rclick:<x>,<y>`.

Window is 1100x700; the tab bar is y≈22, the status bar y≈688.

## Gotchas

- Rust changes: `tauri dev` rebuilds and restarts the app by itself (the layout is not saved on that restart).
- Frontend changes: no hot reload (the dev CSP only allows the 1420 websocket); run `node scripts/drive.mjs eval:"location.reload()"`.
- Seeding data with `eval:` through bash eats backslashes: write Windows paths with `/` (`D:/Will Projects`).
- The PowerShell profile error in red on every pane is the machine's execution policy, not the app.
- `exit` (code 0) closes a pane; a shell ending with another code keeps the pane with the code (Enter restarts).

## Stop and clean up

```powershell
Get-Process will-terminal | Where-Object Path -like '*target\test*' | Stop-Process
Remove-Item -Recurse "$env:LOCALAPPDATA\com.wiliammp.will-terminal.test"   # test data and logs
```
