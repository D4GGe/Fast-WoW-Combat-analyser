// Hide console window in release builds (double-click friendly)
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tokio::sync::Notify;

mod api;
mod gui;
mod models;
mod parser;

const DEFAULT_LOG_DIR: &str = r"C:\World of Warcraft\_retail_\Logs";
const PORT: u16 = 3000;

fn main() {
    // 1. Resolve log directory
    let log_dir = resolve_log_dir();

    // 2. Shared mutable log_dir (GUI can change it at runtime)
    let shared_log_dir = Arc::new(Mutex::new(log_dir));

    // 3. Setup cross-thread shutdown signal
    let shutdown = Arc::new(Notify::new());
    let shutdown_for_server = shutdown.clone();
    let shutdown_for_api = shutdown.clone();

    // 4. Start HTTP server in background thread (with its own tokio runtime)
    let server_log_dir = shared_log_dir.clone();
    let server_handle = std::thread::spawn(move || {
        let rt = tokio::runtime::Runtime::new().expect("Failed to create tokio runtime");
        rt.block_on(async {
            let app = api::create_router(server_log_dir, shutdown_for_api);
            let listener = match tokio::net::TcpListener::bind(format!("0.0.0.0:{}", PORT)).await {
                Ok(l) => l,
                Err(_e) => {
                    #[cfg(debug_assertions)]
                    eprintln!("Failed to bind port {}: {}", PORT, _e);
                    return;
                }
            };
            axum::serve(listener, app)
                .with_graceful_shutdown(async move {
                    shutdown_for_server.notified().await;
                })
                .await
                .ok();
        });
    });

    // Brief pause so server is ready before opening browser
    std::thread::sleep(std::time::Duration::from_millis(600));

    // 5. Open browser automatically
    let _ = open::that(format!("http://localhost:{}", PORT));

    // 6. Run the native GUI window (blocks until closed or Stop pressed)
    gui::run(shutdown.clone(), shared_log_dir.clone(), PORT);

    // 7. Wait for server thread to finish gracefully
    let _ = server_handle.join();
}

fn resolve_log_dir() -> PathBuf {
    // Check CLI argument first (skip dialog)
    if let Some(arg) = std::env::args().nth(1) {
        let p = PathBuf::from(&arg);
        if p.exists() {
            return p;
        }
    }

    // Use default path if it exists
    let default = PathBuf::from(DEFAULT_LOG_DIR);
    if default.exists() {
        return default;
    }

    // Default not found — show folder picker
    match rfd::FileDialog::new()
        .set_title("Select WoW Combat Log Directory")
        .set_directory(r"C:\")
        .pick_folder()
    {
        Some(path) => path,
        None => std::process::exit(0),
    }
}
