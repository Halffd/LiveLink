use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let window = app.get_webview_window("main").unwrap();
            window.set_title("LiveLink - Streaming Manager").unwrap();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_app_info,
            check_system_requirements
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
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