use tauri::{
    image::Image,
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WebviewWindow,
};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

mod config;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::init();
    log::info!("Starting LiveLink Tauri application");

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let window = app.get_webview_window("main").unwrap();

            setup_tray(app, &window)?;
            setup_shortcuts(app, &window)?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_app_info,
            check_system_requirements,
            config::read_config,
            config::write_config,
            config::get_config_path,
            window_toggle_fullscreen,
            window_minimize,
            window_maximize,
            window_close,
            window_hide,
            window_show
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn setup_tray(app: &tauri::App, _window: &WebviewWindow) -> Result<(), Box<dyn std::error::Error>> {
    let show_item = MenuItemBuilder::with_id("show", "Show LiveLink").build(app)?;
    let hide_item = MenuItemBuilder::with_id("hide", "Hide").build(app)?;
    let separator = tauri::menu::PredefinedMenuItem::separator(app)?;
    let quit_item = MenuItemBuilder::with_id("quit", "Quit").build(app)?;

    let menu = MenuBuilder::new(app)
        .item(&show_item)
        .item(&hide_item)
        .item(&separator)
        .item(&quit_item)
        .build()?;

    let icon_bytes = include_bytes!("../icons/32x32.png");
    let icon = Image::from_bytes(icon_bytes)?;

    let _tray = TrayIconBuilder::new()
        .icon(icon)
        .menu(&menu)
        .tooltip("LiveLink - Streaming Manager")
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "hide" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
            }
            "quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
        })
        .build(app)?;

    log::info!("Tray icon created successfully");
    Ok(())
}

fn setup_shortcuts(app: &tauri::App, _window: &WebviewWindow) -> Result<(), Box<dyn std::error::Error>> {
    let shortcut_show = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyL);
    let shortcut_fullscreen = Shortcut::new(None, Code::F11);
    let shortcut_hide = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyH);

    let _ = app.global_shortcut().on_shortcut(shortcut_show, |_app, _shortcut, event| {
        if event.state == ShortcutState::Pressed {
            if let Some(w) = _app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }
    });

    let _ = app.global_shortcut().on_shortcut(shortcut_fullscreen, |_app, _shortcut, event| {
        if event.state == ShortcutState::Pressed {
            if let Some(w) = _app.get_webview_window("main") {
                if w.is_fullscreen().unwrap_or(false) {
                    let _ = w.set_fullscreen(false);
                } else {
                    let _ = w.set_fullscreen(true);
                }
            }
        }
    });

    let _ = app.global_shortcut().on_shortcut(shortcut_hide, |_app, _shortcut, event| {
        if event.state == ShortcutState::Pressed {
            if let Some(w) = _app.get_webview_window("main") {
                let _ = w.hide();
            }
        }
    });

    log::info!("Global shortcuts registered: Ctrl+Shift+L (show), F11 (fullscreen), Ctrl+Shift+H (hide)");
    Ok(())
}

#[tauri::command]
fn get_app_info() -> serde_json::Value {
    serde_json::json!({
        "name": "LiveLink",
        "version": env!("CARGO_PKG_VERSION"),
        "description": "LiveLink Desktop - Streaming Manager"
    })
}

#[tauri::command]
fn check_system_requirements() -> serde_json::Value {
    let mpv_available = std::process::Command::new("mpv")
        .arg("--version")
        .output()
        .is_ok();
    let streamlink_available = std::process::Command::new("streamlink")
        .arg("--version")
        .output()
        .is_ok();

    serde_json::json!({
        "mpv": mpv_available,
        "streamlink": streamlink_available
    })
}

#[tauri::command]
fn window_toggle_fullscreen(window: WebviewWindow) -> Result<bool, String> {
    let is_fullscreen = window.is_fullscreen().map_err(|e| e.to_string())?;
    window.set_fullscreen(!is_fullscreen).map_err(|e| e.to_string())?;
    Ok(!is_fullscreen)
}

#[tauri::command]
fn window_minimize(window: WebviewWindow) -> Result<(), String> {
    window.minimize().map_err(|e| e.to_string())
}

#[tauri::command]
fn window_maximize(window: WebviewWindow) -> Result<(), String> {
    if window.is_maximized().unwrap_or(false) {
        window.unmaximize().map_err(|e| e.to_string())
    } else {
        window.maximize().map_err(|e| e.to_string())
    }
}

#[tauri::command]
fn window_close(window: WebviewWindow) -> Result<(), String> {
    window.close().map_err(|e| e.to_string())
}

#[tauri::command]
fn window_hide(window: WebviewWindow) -> Result<(), String> {
    window.hide().map_err(|e| e.to_string())
}

#[tauri::command]
fn window_show(window: WebviewWindow) -> Result<(), String> {
    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())
}
