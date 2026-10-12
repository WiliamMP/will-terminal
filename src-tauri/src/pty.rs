// Integrated terminal: a real shell (PowerShell, cmd, Git Bash, WSL) running in a
// pseudo-terminal (ConPTY on Windows), streamed to xterm.js in the window.
// Each session lives in a map by id, like a list of TProcess objects.

use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

type Res<T> = Result<T, String>;

struct Session {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    // the child itself is owned by its waiter thread; this only ends it
    killer: Box<dyn ChildKiller + Send + Sync>,
    // which spawn this is: restarting a pane reuses its id, and the old waiter must not report the new shell's exit
    token: u64,
    // pipe-pane: while Some, everything the shell prints also goes to this file, as plain text
    log: Arc<Mutex<Option<File>>>,
}

static NEXT_TOKEN: AtomicU64 = AtomicU64::new(1);

#[derive(Default)]
pub struct Terminals {
    sessions: Mutex<HashMap<u32, Session>>,
}

#[derive(Clone, Serialize)]
struct Output {
    id: u32,
    data: String,
}

#[derive(Clone, Serialize)]
struct Exit {
    id: u32,
    code: u32,
}

/// Text for the log file: escape sequences (colors, cursor moves, OSC) removed, line ends kept
// ponytail: a sequence cut between two reads leaks a few characters; full-screen programs (vim) log as a jumble
fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut it = s.chars();
    while let Some(c) = it.next() {
        match c {
            '\x1b' => match it.next() {
                // CSI: parameters, then one final byte in @..~
                Some('[') => {
                    for n in it.by_ref() {
                        if ('@'..='~').contains(&n) {
                            break;
                        }
                    }
                }
                // OSC: until BEL or ESC \
                Some(']') => {
                    while let Some(n) = it.next() {
                        if n == '\x07' {
                            break;
                        }
                        if n == '\x1b' {
                            it.next();
                            break;
                        }
                    }
                }
                _ => {} // two-character sequence
            },
            '\n' | '\t' => out.push(c),
            // \r: ConPTY ends lines with \r\n, a lone one redraws the line
            c if c.is_control() => {}
            c => out.push(c),
        }
    }
    out
}

// Shell integration: every prompt prints two invisible sequences before itself.
// - OSC 133;D;<exit code>: the previous command ended (FinalTerm / VS Code convention),
//   for the ok/error badge and the "command finished" notification.
// - OSC 9;9;<folder>: the current folder (same as Windows Terminal), so a new pane opens there.
// PowerShell: wraps the prompt from the user's profile, which already ran. `$?` must be read first,
// before anything else in the prompt resets it.
const PS_PROMPT: &str = r#"$__will_prompt = $function:prompt; function prompt { $c = if ($?) { 0 } elseif ($LASTEXITCODE) { $LASTEXITCODE } else { 1 }; $e = [char]27; $b = [char]7; "$e]133;D;$c$b$e]9;9;$($executionContext.SessionState.Path.CurrentLocation.ProviderPath)$b" + (& $__will_prompt) }"#;

// bash (Git Bash and WSL): `to_windows` turns $PWD into a Windows path (cygpath / wslpath)
fn bash_prompt(to_windows: &str) -> String {
    format!(r#"__c=$?; printf '\e]133;D;%s\e\\\e]9;9;%s\e\\' "$__c" "$({to_windows} -w "$PWD")""#)
}

fn powershell(exe: &str) -> CommandBuilder {
    let mut c = CommandBuilder::new(exe);
    c.args(["-NoLogo", "-NoExit", "-Command", PS_PROMPT]);
    c
}

/// Program for the terminal setting; Windows Terminal itself can't be embedded, so it uses PowerShell
fn shell(kind: &str) -> CommandBuilder {
    match kind {
        "cmd" => {
            let mut c = CommandBuilder::new("cmd.exe");
            // cmd's PROMPT can't read %ERRORLEVEL%: it says "ended" without a code
            c.env("PROMPT", r"$e]133;D$e\$e]9;9;$P$e\$P$G");
            c
        }
        "pwsh" => powershell("pwsh.exe"),
        "git-bash" => {
            let base = std::env::var("ProgramFiles").unwrap_or_else(|_| r"C:\Program Files".into());
            let mut c = CommandBuilder::new(format!(r"{base}\Git\bin\bash.exe"));
            c.arg("--login");
            c.arg("-i");
            // ponytail: a ~/.bashrc that sets its own PROMPT_COMMAND wins and the folder/exit code are not reported
            c.env("PROMPT_COMMAND", bash_prompt("cygpath"));
            c
        }
        "wsl" => {
            let mut c = CommandBuilder::new("wsl.exe");
            c.env("PROMPT_COMMAND", bash_prompt("wslpath"));
            // WSLENV lists the Windows variables that cross into Linux (/u = only this direction)
            let wslenv = std::env::var("WSLENV").unwrap_or_default();
            c.env("WSLENV", if wslenv.is_empty() { "PROMPT_COMMAND/u".into() } else { format!("{wslenv}:PROMPT_COMMAND/u") });
            c
        }
        _ => powershell("powershell.exe"),
    }
}

/// Bytes that end in the middle of a UTF-8 character wait for the next read
fn take_utf8(pending: &mut Vec<u8>) -> String {
    let valid = match std::str::from_utf8(pending) {
        Ok(_) => pending.len(),
        // error_len None = incomplete character at the end, keep it for later
        Err(e) if e.error_len().is_none() => e.valid_up_to(),
        Err(_) => pending.len(), // really invalid bytes: show them lossy
    };
    let text = String::from_utf8_lossy(&pending[..valid]).into_owned();
    pending.drain(..valid);
    text
}

/// `id` comes from the window, which starts listening for its output *before* the
/// shell starts: the first thing ConPTY sends is a cursor-position question that
/// must be answered, and an event sent before the listener exists would be lost.
#[tauri::command]
pub fn pty_spawn(
    app: AppHandle,
    state: State<Terminals>,
    id: u32,
    cwd: String,
    shell_kind: String,
    env: Option<Vec<(String, String)>>,
    cols: u16,
    rows: u16,
) -> Res<()> {
    let pair = native_pty_system()
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;
    let mut cmd = shell(&shell_kind);
    // profile variables; WSL only sees them if the profile also lists them in WSLENV
    for (k, v) in env.unwrap_or_default() {
        cmd.env(k, v);
    }
    // a folder that is gone (or a PowerShell drive like HKLM:) opens in the user folder instead of failing
    if std::path::Path::new(&cwd).is_dir() {
        cmd.cwd(&cwd);
    } else if let Ok(home) = std::env::var("USERPROFILE") {
        cmd.cwd(home);
    }
    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("Não foi possível abrir o terminal: {e}"))?;
    drop(pair.slave); // the child keeps its own handle; ours would keep the pty open after exit
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let token = NEXT_TOKEN.fetch_add(1, Ordering::Relaxed);
    let log = Arc::new(Mutex::new(None::<File>));

    // a restart replaces the old shell under the same id
    if let Some(mut old) = state.sessions.lock().unwrap().insert(
        id,
        Session {
            writer,
            master: pair.master,
            killer: child.clone_killer(),
            token,
            log: log.clone(),
        },
    ) {
        let _ = old.killer.kill();
    }

    // Waiter thread: the end of the shell is the end of the child process, not of the output. ConPTY keeps
    // the output open (its conhost stays alive) while we hold the pty, so the reader alone never sees the end.
    let waiter_app = app.clone();
    std::thread::spawn(move || {
        let code = child.wait().map(|st| st.exit_code()).unwrap_or(u32::MAX);
        // only a shell that ended on its own is reported: a killed or replaced one is no longer in the map.
        // Removing it drops the pty, which closes ConPTY and ends the reader thread too.
        let ended = {
            let state = waiter_app.state::<Terminals>();
            let mut sessions = state.sessions.lock().unwrap();
            match sessions.get(&id) {
                Some(s) if s.token == token => sessions.remove(&id),
                _ => None,
            }
        };
        if ended.is_some() {
            let _ = waiter_app.emit("pty-exit", Exit { id, code });
        }
    });

    // reader thread: shell output -> "pty-output" events (and the log file)
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        let mut pending = Vec::new();
        while let Ok(n) = reader.read(&mut buf) {
            if n == 0 {
                break;
            }
            pending.extend_from_slice(&buf[..n]);
            let data = take_utf8(&mut pending);
            if !data.is_empty() {
                if let Some(f) = log.lock().unwrap().as_mut() {
                    let _ = f.write_all(strip_ansi(&data).as_bytes());
                }
                let _ = app.emit("pty-output", Output { id, data });
            }
        }
    });
    Ok(())
}

/// pipe-pane: starts copying the pane's output, as plain text, to `<app log folder>/<name>.log`; returns the path
#[tauri::command]
pub fn pty_log_start(app: AppHandle, state: State<Terminals>, id: u32, name: String) -> Res<String> {
    let dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let safe: String = name.chars().map(|c| if c.is_alphanumeric() || "-_. ".contains(c) { c } else { '_' }).collect();
    let path = dir.join(format!("{safe}.log"));
    let file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("Não foi possível criar {}: {e}", path.display()))?;
    let sessions = state.sessions.lock().unwrap();
    let s = sessions.get(&id).ok_or("Terminal fechado")?;
    *s.log.lock().unwrap() = Some(file);
    Ok(path.display().to_string())
}

#[tauri::command]
pub fn pty_log_stop(state: State<Terminals>, id: u32) -> Res<()> {
    if let Some(s) = state.sessions.lock().unwrap().get(&id) {
        *s.log.lock().unwrap() = None;
    }
    Ok(())
}

#[tauri::command]
pub fn pty_write(state: State<Terminals>, id: u32, data: String) -> Res<()> {
    let mut sessions = state.sessions.lock().unwrap();
    let s = sessions.get_mut(&id).ok_or("Terminal fechado")?;
    s.writer
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_resize(state: State<Terminals>, id: u32, cols: u16, rows: u16) -> Res<()> {
    let sessions = state.sessions.lock().unwrap();
    let s = sessions.get(&id).ok_or("Terminal fechado")?;
    s.master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_kill(state: State<Terminals>, id: u32) -> Res<()> {
    if let Some(mut s) = state.sessions.lock().unwrap().remove(&id) {
        let _ = s.killer.kill();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_ansi_keeps_only_the_text() {
        let raw = "\x1b[32mok\x1b[0m done\r\n\x1b]9;9;C:\\x\x07\x1b]133;D;0\x1b\\PS> \x1b[?25h";
        assert_eq!(strip_ansi(raw), "ok done\nPS> ");
    }

    /// The exit code reaches us through ConPTY (shown when a pane's shell ends with an error)
    #[test]
    fn exit_code_comes_through() {
        let pair = native_pty_system()
            .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
            .unwrap();
        let mut cmd = CommandBuilder::new("cmd.exe");
        cmd.args(["/C", "exit 3"]);
        let mut child = pair.slave.spawn_command(cmd).unwrap();
        drop(pair.slave);
        let mut writer = pair.master.take_writer().unwrap();
        writer.write_all(b"\x1b[1;1R").unwrap();
        assert_eq!(child.wait().unwrap().exit_code(), 3);
    }

    #[test]
    fn utf8_split_across_reads() {
        // "ção" arrives cut in the middle of "ç"
        let bytes = "ação".as_bytes();
        let mut pending = bytes[..2].to_vec();
        assert_eq!(take_utf8(&mut pending), "a");
        assert_eq!(pending.len(), 1);
        pending.extend_from_slice(&bytes[2..]);
        assert_eq!(take_utf8(&mut pending), "ção");
        assert!(pending.is_empty());
    }

    /// Real shell in a pty until `want` shows up in its output (or 15s)
    fn read_until(mut cmd: CommandBuilder, want: &str) -> String {
        let pair = native_pty_system()
            .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
            .unwrap();
        cmd.cwd(std::env::temp_dir());
        let mut child = pair.slave.spawn_command(cmd).unwrap();
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().unwrap();
        let mut writer = pair.master.take_writer().unwrap();
        writer.write_all(b"\x1b[1;1R").unwrap(); // ConPTY's cursor-position question, see below
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            while let Ok(n) = reader.read(&mut buf) {
                if n == 0 || tx.send(String::from_utf8_lossy(&buf[..n]).into_owned()).is_err() {
                    break;
                }
            }
        });
        let mut all = String::new();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
        while !all.contains(want) && std::time::Instant::now() < deadline {
            if let Ok(chunk) = rx.recv_timeout(std::time::Duration::from_millis(200)) {
                all.push_str(&chunk);
            }
        }
        let _ = child.kill();
        all
    }

    /// The prompts report their folder and the last exit code through ConPTY
    #[test]
    fn prompts_report_folder_and_exit_code() {
        let dir = std::env::temp_dir();
        let want = format!("\x1b]9;9;{}", dir.to_string_lossy().trim_end_matches('\\'));
        for (kind, end) in [("powershell", "\x1b]133;D;0"), ("cmd", "\x1b]133;D")] {
            let out = read_until(shell(kind), &want);
            assert!(out.contains(&want), "{kind}: {out:?}");
            assert!(out.contains(end), "{kind}: {out:?}");
        }
    }

    /// A failing command shows up as a non-zero code in the next prompt
    #[test]
    fn powershell_reports_a_failure() {
        let mut cmd = CommandBuilder::new("powershell.exe");
        // the failing command runs right after the prompt is installed, before the first prompt
        cmd.args(["-NoLogo", "-NoExit", "-Command", &format!("{PS_PROMPT}; cmd /c exit 3")]);
        let out = read_until(cmd, "\x1b]133;D;3");
        assert!(out.contains("\x1b]133;D;3"), "{out:?}");
    }

    /// Git Bash, when installed: same two sequences from PROMPT_COMMAND
    #[test]
    fn git_bash_reports_folder_and_exit_code() {
        let base = std::env::var("ProgramFiles").unwrap_or_default();
        if !std::path::Path::new(&format!(r"{base}\Git\bin\bash.exe")).exists() {
            return;
        }
        let out = read_until(shell("git-bash"), "\x1b]9;9;");
        assert!(out.contains("\x1b]133;D;0\x1b\\\x1b]9;9;"), "{out:?}");
    }

    /// WSL, when a distro is installed: PROMPT_COMMAND crosses into Linux through WSLENV
    #[test]
    fn wsl_reports_folder_and_exit_code() {
        let has_distro = std::process::Command::new("wsl.exe")
            .args(["--list", "--quiet"])
            .output()
            .is_ok_and(|o| o.status.success() && o.stdout.iter().any(|b| b.is_ascii_alphanumeric()));
        if !has_distro {
            return;
        }
        let out = read_until(shell("wsl"), "\x1b]9;9;");
        assert!(out.contains("\x1b]133;D;0\x1b\\\x1b]9;9;"), "{out:?}");
    }

    /// Real shell in a pty: runs a command and reads its output
    #[test]
    fn real_pty_runs_a_command() {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let mut cmd = CommandBuilder::new("cmd.exe");
        cmd.args(["/C", "echo ola-pty"]);
        let _child = pair.slave.spawn_command(cmd).unwrap();
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().unwrap();
        let mut writer = pair.master.take_writer().unwrap();
        // ConPTY first asks where the cursor is ("ESC[6n") and waits for the answer;
        // xterm.js answers by itself in the app, here we answer by hand
        writer.write_all(b"[1;1R").unwrap();

        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            while let Ok(n) = reader.read(&mut buf) {
                if n == 0
                    || tx
                        .send(String::from_utf8_lossy(&buf[..n]).into_owned())
                        .is_err()
                {
                    break;
                }
            }
        });
        let mut all = String::new();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while !all.contains("ola-pty") && std::time::Instant::now() < deadline {
            if let Ok(chunk) = rx.recv_timeout(std::time::Duration::from_millis(200)) {
                all.push_str(&chunk);
            }
        }
        drop(pair.master);
        assert!(all.contains("ola-pty"), "{all:?}");
    }
}
