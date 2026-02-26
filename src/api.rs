use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{Html, Json},
    routing::{get, post},
    Router,
};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::{Mutex, Notify};
use std::collections::HashMap;
use rust_embed::Embed;

use crate::models::*;
use crate::parser;

#[derive(Embed)]
#[folder = "frontend/dist"]
struct FrontendAssets;

struct AppState {
    log_dir: Arc<std::sync::Mutex<PathBuf>>,
    cache: Mutex<HashMap<String, (u64, CombatLogSummary)>>,
    shutdown: Arc<Notify>,
}

pub fn create_router(log_dir: Arc<std::sync::Mutex<PathBuf>>, shutdown: Arc<Notify>) -> Router {
    let state = Arc::new(AppState {
        log_dir,
        cache: Mutex::new(HashMap::new()),
        shutdown,
    });

    Router::new()
        .route("/logo.png", get(serve_logo))
        .route("/favicon.png", get(serve_favicon))
        .route("/api/logs", get(list_logs))
        .route("/api/logs/{filename}/summary", get(log_summary))
        .route("/api/logs/{filename}/encounter/{index}", get(encounter_detail))
        .route("/api/logs/{filename}/encounter/{index}/replay", get(encounter_replay))
        .route("/api/spell_tooltips", get(serve_spell_tooltips))
        .fallback(get(embedded_frontend))
        .with_state(state)
}

/// Serve embedded frontend assets, with SPA fallback to index.html
async fn embedded_frontend(uri: axum::http::Uri) -> impl axum::response::IntoResponse {
    let path = uri.path().trim_start_matches('/');

    // Try to serve the exact file
    if let Some(file) = FrontendAssets::get(path) {
        let mime = mime_guess::from_path(path).first_or_octet_stream();
        return (
            StatusCode::OK,
            [(axum::http::header::CONTENT_TYPE, mime.as_ref().to_string())],
            file.data.to_vec(),
        );
    }

    // SPA fallback: serve index.html for any unmatched route
    if let Some(index) = FrontendAssets::get("index.html") {
        return (
            StatusCode::OK,
            [(axum::http::header::CONTENT_TYPE, "text/html".to_string())],
            index.data.to_vec(),
        );
    }

    (
        StatusCode::NOT_FOUND,
        [(axum::http::header::CONTENT_TYPE, "text/plain".to_string())],
        b"Not Found".to_vec(),
    )
}

async fn serve_logo() -> impl axum::response::IntoResponse {
    ([(axum::http::header::CONTENT_TYPE, "image/png")], include_bytes!("../assets/logo.png"))
}

async fn serve_favicon() -> impl axum::response::IntoResponse {
    ([(axum::http::header::CONTENT_TYPE, "image/png")], include_bytes!("../assets/favicon.png"))
}

async fn serve_spell_tooltips() -> impl axum::response::IntoResponse {
    let json = include_str!("../frontend/spell_tooltips.json");
    ([(axum::http::header::CONTENT_TYPE, "application/json")], json)
}

async fn list_logs(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<LogFileInfo>>, (StatusCode, String)> {
    let dir = state.log_dir.lock().unwrap().clone();

    let mut logs: Vec<LogFileInfo> = Vec::new();
    let mut dirs_to_scan = vec![dir];

    while let Some(scan_dir) = dirs_to_scan.pop() {
        let entries = match std::fs::read_dir(&scan_dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                dirs_to_scan.push(path);
                continue;
            }
            if path.extension().and_then(|e| e.to_str()) == Some("txt") {
                if let Some(filename) = path.file_name().and_then(|n| n.to_str()) {
                    if filename.starts_with("WoWCombatLog") {
                        let metadata = std::fs::metadata(&path).ok();
                        let size_bytes = metadata.as_ref().map(|m| m.len()).unwrap_or(0);

                        logs.push(LogFileInfo {
                            filename: filename.to_string(),
                            size_bytes,
                            size_display: format_size(size_bytes),
                            date_str: extract_date_from_filename(filename),
                        });
                    }
                }
            }
        }
    }

    // Sort by actual date (convert MMDDYY_HHMMSS to YYMMDD_HHMMSS for correct chronological order)
    logs.sort_by(|a, b| {
        let key = |f: &str| -> String {
            let name = f.trim_start_matches("WoWCombatLog-").trim_end_matches(".txt");
            if name.len() >= 6 {
                format!("{}{}{}{}", &name[4..6], &name[0..2], &name[2..4], &name[6..])
            } else {
                name.to_string()
            }
        };
        key(&b.filename).cmp(&key(&a.filename))
    });
    logs.dedup_by(|a, b| a.filename == b.filename);

    Ok(Json(logs))
}

async fn log_summary(
    State(state): State<Arc<AppState>>,
    Path(filename): Path<String>,
) -> Result<axum::response::Response, (StatusCode, String)> {
    use axum::response::IntoResponse;

    // Sanitize filename
    if filename.contains("..") || filename.contains('/') || filename.contains('\\') {
        return Err((StatusCode::BAD_REQUEST, "Invalid filename".to_string()));
    }

    // Search recursively for the file
    let log_dir = state.log_dir.lock().unwrap().clone();
    let path = find_file_recursive(&log_dir, &filename)
        .ok_or((StatusCode::NOT_FOUND, "Log file not found".to_string()))?;

    // Check current file size
    let current_size = std::fs::metadata(&path)
        .map(|m| m.len())
        .unwrap_or(0);

    // Check cache — if file size unchanged, return cached result instantly
    {
        let cache = state.cache.lock().await;
        if let Some((cached_size, cached_summary)) = cache.get(&filename) {
            if *cached_size == current_size {
                println!("📦 Cache HIT for {} (size unchanged: {} bytes)", filename, current_size);
                let headers = [
                    ("X-Cache-Status", "HIT".to_string()),
                    ("X-Parse-Time", "0".to_string()),
                ];
                return Ok((headers, Json(cached_summary.clone())).into_response());
            }
            println!("🔄 Cache STALE for {} (size changed: {} -> {} bytes)", filename, cached_size, current_size);
        } else {
            println!("🆕 No cache for {}, parsing... ({} bytes)", filename, current_size);
        }
    }

    // File changed or not cached — parse it
    let fname = filename.clone();
    let parse_filename = filename.clone();
    let summary = tokio::task::spawn_blocking(move || {
        let start = std::time::Instant::now();
        let result = parser::parse_combat_log(&path);
        let elapsed = start.elapsed().as_secs_f64();
        println!("⏱️  Parsed {} in {:.1}s", parse_filename, elapsed);
        result.map(|s| (s, elapsed))
    })
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Task failed: {}", e)))?
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    let (summary, parse_time) = summary;

    // Store in cache
    {
        let mut cache = state.cache.lock().await;
        cache.insert(fname, (current_size, summary.clone()));
    }

    let headers = [
        ("X-Cache-Status", "PARSED".to_string()),
        ("X-Parse-Time", format!("{:.2}", parse_time)),
    ];
    Ok((headers, Json(summary)).into_response())
}

async fn encounter_detail(
    State(state): State<Arc<AppState>>,
    Path((filename, index)): Path<(String, usize)>,
) -> Result<Json<EncounterSummary>, (StatusCode, String)> {
    // Sanitize filename
    if filename.contains("..") || filename.contains('/') || filename.contains('\\') {
        return Err((StatusCode::BAD_REQUEST, "Invalid filename".to_string()));
    }

    let log_dir = state.log_dir.lock().unwrap().clone();
    let path = find_file_recursive(&log_dir, &filename)
        .ok_or((StatusCode::NOT_FOUND, "Log file not found".to_string()))?;

    // Check current file size
    let current_size = std::fs::metadata(&path)
        .map(|m| m.len())
        .unwrap_or(0);

    // Check cache first — if file size unchanged, use cached summary
    {
        let cache = state.cache.lock().await;
        if let Some((cached_size, cached_summary)) = cache.get(&filename) {
            if *cached_size == current_size {
                println!("📦 Cache HIT for {} encounter {} (size unchanged)", filename, index);
                return cached_summary.encounters.iter().nth(index)
                    .cloned()
                    .map(Json)
                    .ok_or((StatusCode::NOT_FOUND, "Encounter not found".to_string()));
            }
        }
    }

    // Not cached or file changed — parse it
    println!("🔄 Parsing {} for encounter {} (no cache)", filename, index);
    let fname = filename.clone();
    let summary = tokio::task::spawn_blocking(move || {
        parser::parse_combat_log(&path)
    })
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Task failed: {}", e)))?
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    let result = summary.encounters.iter().nth(index)
        .cloned()
        .map(Json)
        .ok_or((StatusCode::NOT_FOUND, "Encounter not found".to_string()));

    // Store in cache for future requests
    {
        let mut cache = state.cache.lock().await;
        cache.insert(fname, (current_size, summary));
    }

    result
}

async fn encounter_replay(
    State(state): State<Arc<AppState>>,
    Path((filename, index)): Path<(String, usize)>,
) -> Result<Json<ReplayData>, (StatusCode, String)> {
    // Sanitize filename
    if filename.contains("..") || filename.contains('/') || filename.contains('\\') {
        return Err((StatusCode::BAD_REQUEST, "Invalid filename".to_string()));
    }

    let log_dir = state.log_dir.lock().unwrap().clone();
    let path = find_file_recursive(&log_dir, &filename)
        .ok_or((StatusCode::NOT_FOUND, "Log file not found".to_string()))?;

    let current_size = std::fs::metadata(&path)
        .map(|m| m.len())
        .unwrap_or(0);

    // Check cache
    {
        let cache = state.cache.lock().await;
        if let Some((cached_size, cached_summary)) = cache.get(&filename) {
            if *cached_size == current_size {
                println!("📦 Replay cache HIT for {} encounter {}", filename, index);
                let enc = cached_summary.encounters.iter().nth(index)
                    .ok_or((StatusCode::NOT_FOUND, "Encounter not found".to_string()))?;
                return Ok(Json(ReplayData {
                    replay_timeline: enc.replay_timeline.clone(),
                    boss_positions: enc.boss_positions.clone(),
                    raw_ability_events: enc.raw_ability_events.clone(),
                }));
            }
        }
    }

    // Parse if not cached
    let fname = filename.clone();
    let summary = tokio::task::spawn_blocking(move || {
        parser::parse_combat_log(&path)
    })
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Task failed: {}", e)))?
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    let enc = summary.encounters.iter().nth(index)
        .ok_or((StatusCode::NOT_FOUND, "Encounter not found".to_string()))?;

    let result = Ok(Json(ReplayData {
        replay_timeline: enc.replay_timeline.clone(),
        boss_positions: enc.boss_positions.clone(),
        raw_ability_events: enc.raw_ability_events.clone(),
    }));

    // Store in cache
    {
        let mut cache = state.cache.lock().await;
        cache.insert(fname, (current_size, summary));
    }

    result
}

fn format_size(bytes: u64) -> String {
    if bytes >= 1_073_741_824 {
        format!("{:.1} GB", bytes as f64 / 1_073_741_824.0)
    } else if bytes >= 1_048_576 {
        format!("{:.1} MB", bytes as f64 / 1_048_576.0)
    } else if bytes >= 1024 {
        format!("{:.1} KB", bytes as f64 / 1024.0)
    } else {
        format!("{} B", bytes)
    }
}

fn extract_date_from_filename(filename: &str) -> String {
    // WoWCombatLog-MMDDYY_HHMMSS.txt
    let name = filename.trim_start_matches("WoWCombatLog-").trim_end_matches(".txt");
    let parts: Vec<&str> = name.split('_').collect();
    if let Some(date_part) = parts.first() {
        if date_part.len() == 6 {
            let month = &date_part[0..2];
            let day = &date_part[2..4];
            let year = &date_part[4..6];
            return format!("20{}-{}-{}", year, month, day);
        }
    }
    "Unknown".to_string()
}

/// Recursively search for a file by name in a directory tree
fn find_file_recursive(dir: &std::path::Path, target: &str) -> Option<std::path::PathBuf> {
    let mut dirs = vec![dir.to_path_buf()];
    while let Some(d) = dirs.pop() {
        if let Ok(entries) = std::fs::read_dir(&d) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    dirs.push(path);
                } else if path.file_name().and_then(|n| n.to_str()) == Some(target) {
                    return Some(path);
                }
            }
        }
    }
    None
}
