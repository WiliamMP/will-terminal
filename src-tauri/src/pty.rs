// Integrated terminal: a real shell (PowerShell, cmd, Git Bash, WSL) running in a
// pseudo-terminal (ConPTY on Windows), streamed to xterm.js in the window.
// Each session lives in a map by id, like a list of TProcess objects.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

type Res<T> = Result<T, String>;

struct Session {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn Child + Send + Sync>,
}

#[derive(Default)]
pub struct Terminals {
    sessions: Mutex<HashMap<u32, Session>>,
}

#[derive(Clone, Serialize)]
struct Output {
    id: u32,
    data: String,
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
    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("Não foi possível abrir o terminal: {e}"))?;
    drop(pair.slave); // the child keeps its own handle; ours would keep the pty open after exit
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    state.sessions.lock().unwrap().insert(
        id,
        Session {
            writer,
            master: pair.master,
            child,
        },
    );

    // reader thread: shell output -> "pty-output" events, then "pty-exit"
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
                let _ = app.emit("pty-output", Output { id, data });
            }
        }
        let _ = app.emit("pty-exit", id);
    });
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
        let _ = s.child.kill();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

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
