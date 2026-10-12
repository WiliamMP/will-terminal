mod pty;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};

/// Called by the main window once its first screen is loaded: show it, close the splash
#[tauri::command]
fn close_splash(app: AppHandle) -> Result<(), String> {
    if let Some(main) = app.get_webview_window("main") {
        main.show().map_err(|e| e.to_string())?;
        main.set_focus().map_err(|e| e.to_string())?;
    }
    if let Some(splash) = app.get_webview_window("splashscreen") {
        splash.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Ends the app (and every shell). The window calls it after saving the layout.
#[tauri::command]
fn exit_app(app: AppHandle) {
    app.exit(0);
}

/// Project folders for the sessionizer: the subfolders of `root`, without hidden ones, sorted by name
#[tauri::command]
fn list_dirs(root: String) -> Result<Vec<String>, String> {
    let entries = std::fs::read_dir(&root).map_err(|e| format!("Não foi possível ler {root}: {e}"))?;
    let mut dirs: Vec<String> = entries
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| !n.starts_with('.'))
        .collect();
    dirs.sort_by_key(|n| n.to_lowercase());
    Ok(dirs)
}

/// Reattach: the window was only hidden, so its terminals are exactly as they were
fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // first plugin: opening the app again while it runs in the tray shows that one instead of a second copy
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .manage(pty::Terminals::default())
        .setup(|app| {
            // Tray icon: the app lives here while the window is detached (closed with the sessions kept)
            let open = MenuItem::with_id(app, "open", "Abrir will-terminal", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Sair (fecha os terminais)", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &quit])?;
            TrayIconBuilder::new()
                .icon(app.default_window_icon().cloned().ok_or("no app icon")?)
                .tooltip("will-terminal")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, e| match e.id.as_ref() {
                    "open" => show_main(app),
                    // the window saves the layout, then calls exit_app
                    "quit" => {
                        let _ = app.emit("quit-requested", ());
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, e| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
                        show_main(tray.app_handle());
                    }
                })
                .build(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            close_splash,
            exit_app,
            list_dirs,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_dirs_skips_files_and_hidden_folders() {
        let root = std::env::temp_dir().join(format!("will-terminal-dirs-{}", std::process::id()));
        for d in ["beta", "Alpha", ".git"] {
            std::fs::create_dir_all(root.join(d)).unwrap();
        }
        std::fs::write(root.join("notes.txt"), "").unwrap();
        let dirs = list_dirs(root.to_string_lossy().into_owned());
        std::fs::remove_dir_all(&root).unwrap();
        assert_eq!(dirs.unwrap(), ["Alpha", "beta"]);
    }
}
