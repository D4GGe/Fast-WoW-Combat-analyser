//! Spell Tooltip Fetcher
//!
//! Scans WoW combat logs, extracts unique spell IDs, and fetches tooltip data
//! (name, description, icon URL) from the Blizzard Game Data API.
//!
//! Usage:
//!   spell_fetcher [LOG_DIR] [--region eu|us|kr|tw]
//!
//! Environment variables:
//!   BLIZZARD_CLIENT_ID     - OAuth2 client ID
//!   BLIZZARD_CLIENT_SECRET - OAuth2 client secret

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::io::{self, BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

const DEFAULT_LOG_DIR: &str = r"C:\World of Warcraft\_retail_\Logs";
const OUTPUT_FILE: &str = "frontend/spell_tooltips.json";
const CONCURRENCY: usize = 10;

// ── Data types ───────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
struct SpellTooltip {
    name: String,
    description: String,
    icon_url: String,
}

#[derive(Deserialize)]
struct OAuthToken {
    access_token: String,
}

#[derive(Deserialize)]
struct BlizzSpellResponse {
    name: Option<BlizzLocalised>,
    description: Option<BlizzLocalised>,
}

#[derive(Deserialize)]
struct BlizzLocalised {
    #[serde(alias = "en_US", alias = "en_GB")]
    en_us: Option<String>,
    #[allow(dead_code)]
    #[serde(flatten)]
    rest: HashMap<String, serde_json::Value>,
}

#[derive(Deserialize)]
struct BlizzMediaResponse {
    assets: Option<Vec<BlizzAsset>>,
}

#[derive(Deserialize)]
struct BlizzAsset {
    key: Option<String>,
    value: Option<String>,
}

#[derive(Deserialize)]
struct WowheadTooltipResponse {
    name: Option<String>,
    icon: Option<String>,
    tooltip: Option<String>,
}

// ── Log scanning ─────────────────────────────────────────────────────────────

/// Extract all unique spell IDs from combat log files in a directory.
fn scan_logs_for_spell_ids(log_dir: &Path) -> io::Result<HashSet<u64>> {
    let mut spell_ids = HashSet::new();

    let entries: Vec<_> = std::fs::read_dir(log_dir)?
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.path()
                .file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.starts_with("WoWCombatLog") && n.ends_with(".txt"))
                .unwrap_or(false)
        })
        .collect();

    eprintln!("📂 Found {} combat log file(s) in {}", entries.len(), log_dir.display());

    for entry in &entries {
        let path = entry.path();
        let file = std::fs::File::open(&path)?;
        let reader = io::BufReader::new(file);

        for line in reader.lines() {
            let line = match line {
                Ok(l) => l,
                Err(_) => continue,
            };

            // Quick filter: only process SPELL_ lines (not SWING_, UNIT_DIED, etc.)
            if !line.contains("SPELL_") {
                continue;
            }

            // Parse the CSV part after the timestamp+event_type
            // Format: "timestamp  EVENT_TYPE,field0,field1,...,field9(=spell_id),..."
            if let Some(csv_start) = line.find("  ") {
                let csv = &line[csv_start + 2..];
                let fields: Vec<&str> = csv.split(',').collect();
                // field[0] = event type, fields[1..8] = unit GUIDs/names/flags
                // field[9] = spellId for SPELL_ events
                if fields.len() > 9 {
                    if let Ok(id) = fields[9].trim().parse::<u64>() {
                        if id > 0 {
                            spell_ids.insert(id);
                        }
                    }
                }
            }
        }

        eprint!("  ✓ {}: ", path.file_name().unwrap_or_default().to_string_lossy());
        eprintln!("{} unique spells so far", spell_ids.len());
    }

    Ok(spell_ids)
}

// ── Blizzard API ─────────────────────────────────────────────────────────────

async fn get_oauth_token(
    client: &reqwest::Client,
    client_id: &str,
    client_secret: &str,
) -> Result<String, Box<dyn std::error::Error>> {
    let resp = client
        .post("https://oauth.battle.net/oauth/token")
        .basic_auth(client_id, Some(client_secret))
        .form(&[("grant_type", "client_credentials")])
        .send()
        .await?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("OAuth failed ({}): {}", status, body).into());
    }

    let token: OAuthToken = resp.json().await?;
    Ok(token.access_token)
}

async fn fetch_spell(
    client: &reqwest::Client,
    token: &str,
    spell_id: u64,
    region: &str,
) -> Result<SpellTooltip, Box<dyn std::error::Error + Send + Sync>> {
    let namespace = format!("static-{}", region);
    let base_url = format!("https://{}.api.blizzard.com", region);

    // 1. Fetch spell data (name + description)
    let spell_url = format!(
        "{}/data/wow/spell/{}?namespace={}&locale=en_US",
        base_url, spell_id, namespace
    );
    let resp = client
        .get(&spell_url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await?;

    let (name, description) = if resp.status().is_success() {
        // Try parsing as localised first, fall back to simple
        let body = resp.text().await?;
        // Try localised format: { "name": { "en_US": "..." } }
        if let Ok(data) = serde_json::from_str::<BlizzSpellResponse>(&body) {
            let n = data
                .name
                .as_ref()
                .and_then(|l| l.en_us.clone())
                .unwrap_or_default();
            let d = data
                .description
                .as_ref()
                .and_then(|l| l.en_us.clone())
                .unwrap_or_default();
            (n, d)
        } else {
            // Try simple format: { "name": "Fireball", "description": "..." }
            #[derive(Deserialize)]
            struct Simple {
                name: Option<String>,
                description: Option<String>,
            }
            if let Ok(s) = serde_json::from_str::<Simple>(&body) {
                (s.name.unwrap_or_default(), s.description.unwrap_or_default())
            } else {
                (String::new(), String::new())
            }
        }
    } else {
        (String::new(), String::new())
    };

    // 2. Fetch spell media (icon URL)
    let media_url = format!(
        "{}/data/wow/media/spell/{}?namespace={}",
        base_url, spell_id, namespace
    );
    let icon_url = match client
        .get(&media_url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
    {
        Ok(resp) if resp.status().is_success() => {
            if let Ok(media) = resp.json::<BlizzMediaResponse>().await {
                media
                    .assets
                    .as_ref()
                    .and_then(|a| a.iter().find(|a| a.key.as_deref() == Some("icon")))
                    .and_then(|a| a.value.clone())
                    .unwrap_or_default()
            } else {
                String::new()
            }
        }
        _ => String::new(),
    };

    Ok(SpellTooltip {
        name,
        description,
        icon_url,
    })
}

/// Fallback: fetch spell data from Wowhead tooltip API
async fn fetch_spell_wowhead(
    client: &reqwest::Client,
    spell_id: u64,
) -> Result<SpellTooltip, Box<dyn std::error::Error + Send + Sync>> {
    let url = format!("https://nether.wowhead.com/tooltip/spell/{}", spell_id);
    let resp = client
        .get(&url)
        .header("User-Agent", "WoWCombatAnalyser/1.0")
        .send()
        .await?;

    if !resp.status().is_success() {
        return Ok(SpellTooltip {
            name: String::new(),
            description: String::new(),
            icon_url: String::new(),
        });
    }

    let data: WowheadTooltipResponse = resp.json().await?;

    let name = data.name.unwrap_or_default();
    let icon_url = data
        .icon
        .filter(|i| !i.is_empty())
        .map(|i| format!("https://wow.zamimg.com/images/wow/icons/large/{}.jpg", i))
        .unwrap_or_default();

    // Extract description from tooltip HTML (strip all tags)
    let description = data
        .tooltip
        .map(|html| {
            // Simple HTML tag stripper
            let mut result = String::new();
            let mut in_tag = false;
            for ch in html.chars() {
                match ch {
                    '<' => in_tag = true,
                    '>' => in_tag = false,
                    _ if !in_tag => result.push(ch),
                    _ => {}
                }
            }
            // Clean up whitespace
            result
                .replace("&nbsp;", " ")
                .replace("&lt;", "<")
                .replace("&gt;", ">")
                .replace("&amp;", "&")
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
        })
        .unwrap_or_default();

    Ok(SpellTooltip {
        name,
        description,
        icon_url,
    })
}

// ── Main ─────────────────────────────────────────────────────────────────────

#[tokio::main]
async fn main() {
    // Load .env file if present (no external dependency needed)
    if let Ok(contents) = std::fs::read_to_string(".env") {
        for line in contents.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            if let Some((key, value)) = line.split_once('=') {
                let key = key.trim();
                let value = value.trim();
                // Only set if not already in environment (env var takes precedence)
                if std::env::var(key).is_err() {
                    std::env::set_var(key, value);
                }
            }
        }
        eprintln!("📄 Loaded .env file");
    }

    let args: Vec<String> = std::env::args().collect();

    // Parse region flag
    let mut region = "eu".to_string();
    let mut log_dir_arg: Option<String> = None;
    let mut i = 1;
    while i < args.len() {
        if args[i] == "--region" && i + 1 < args.len() {
            region = args[i + 1].to_lowercase();
            i += 2;
        } else {
            log_dir_arg = Some(args[i].clone());
            i += 1;
        }
    }

    // Resolve log directory
    let log_dir = log_dir_arg
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(DEFAULT_LOG_DIR));

    if !log_dir.exists() {
        eprintln!("❌ Log directory not found: {}", log_dir.display());
        eprintln!("   Usage: spell_fetcher [LOG_DIR] [--region eu|us|kr|tw]");
        std::process::exit(1);
    }

    // Get API credentials
    let client_id = std::env::var("BLIZZARD_CLIENT_ID").unwrap_or_else(|_| {
        eprint!("Enter Blizzard Client ID: ");
        io::stderr().flush().ok();
        let mut input = String::new();
        io::stdin().read_line(&mut input).unwrap();
        input.trim().to_string()
    });

    let client_secret = std::env::var("BLIZZARD_CLIENT_SECRET").unwrap_or_else(|_| {
        eprint!("Enter Blizzard Client Secret: ");
        io::stderr().flush().ok();
        let mut input = String::new();
        io::stdin().read_line(&mut input).unwrap();
        input.trim().to_string()
    });

    if client_id.is_empty() || client_secret.is_empty() {
        eprintln!("❌ Client ID and Secret are required.");
        eprintln!("   Set BLIZZARD_CLIENT_ID and BLIZZARD_CLIENT_SECRET environment variables,");
        eprintln!("   or they will be prompted at runtime.");
        std::process::exit(1);
    }

    // 1. Scan logs for spell IDs
    eprintln!("\n🔍 Scanning combat logs...");
    let all_spell_ids = match scan_logs_for_spell_ids(&log_dir) {
        Ok(ids) => ids,
        Err(e) => {
            eprintln!("❌ Failed to scan logs: {}", e);
            std::process::exit(1);
        }
    };
    eprintln!("   Found {} unique spell IDs across all logs", all_spell_ids.len());

    // 2. Load existing tooltips (dedup)
    let output_path = PathBuf::from(OUTPUT_FILE);
    let tooltips: HashMap<String, SpellTooltip> = if output_path.exists() {
        match std::fs::read_to_string(&output_path) {
            Ok(contents) => serde_json::from_str(&contents).unwrap_or_default(),
            Err(_) => HashMap::new(),
        }
    } else {
        HashMap::new()
    };

    let existing_count = tooltips.len();
    let new_ids: Vec<u64> = all_spell_ids
        .iter()
        .filter(|id| !tooltips.contains_key(&id.to_string()))
        .copied()
        .collect();

    eprintln!("   {} spells already cached, {} new to fetch", existing_count, new_ids.len());

    if new_ids.is_empty() {
        eprintln!("✅ Nothing to fetch — all spells are already cached!");
        return;
    }

    // 3. Authenticate with Blizzard API
    eprintln!("\n🔑 Authenticating with Blizzard API ({} region)...", region);
    let client = reqwest::Client::new();
    let token = match get_oauth_token(&client, &client_id, &client_secret).await {
        Ok(t) => {
            eprintln!("   ✓ Token acquired");
            t
        }
        Err(e) => {
            eprintln!("❌ Authentication failed: {}", e);
            std::process::exit(1);
        }
    };

    // 4. Fetch spell data with concurrency
    eprintln!("\n⬇️  Fetching {} spell tooltips...", new_ids.len());
    let fetched = Arc::new(Mutex::new(0usize));
    let total = new_ids.len();
    let tooltips = Arc::new(Mutex::new(tooltips));

    // Process in chunks of CONCURRENCY
    for chunk in new_ids.chunks(CONCURRENCY) {
        let mut handles = Vec::new();

        for &spell_id in chunk {
            let client = client.clone();
            let token = token.clone();
            let region = region.clone();
            let tooltips = tooltips.clone();
            let fetched = fetched.clone();

            handles.push(tokio::spawn(async move {
                // Try Blizzard API first
                let mut tooltip = match fetch_spell(&client, &token, spell_id, &region).await {
                    Ok(t) => t,
                    Err(_) => SpellTooltip { name: String::new(), description: String::new(), icon_url: String::new() },
                };

                // If Blizzard returned empty, try Wowhead as fallback
                if tooltip.name.is_empty() {
                    if let Ok(wh) = fetch_spell_wowhead(&client, spell_id).await {
                        if !wh.name.is_empty() {
                            tooltip = wh;
                        }
                    }
                }

                let name = tooltip.name.clone();
                let source = if !name.is_empty() && tooltip.icon_url.contains("zamimg") { "wh" }
                    else if !name.is_empty() { "blz" }
                    else { "" };
                tooltips.lock().unwrap().insert(spell_id.to_string(), tooltip);
                let count = {
                    let mut f = fetched.lock().unwrap();
                    *f += 1;
                    *f
                };
                if !name.is_empty() {
                    eprint!("\r   [{}/{}] {} ({}) [{}]", count, total, spell_id, name, source);
                } else {
                    eprint!("\r   [{}/{}] {} (unknown)", count, total, spell_id);
                }
                io::stderr().flush().ok();
            }));
        }

        // Await all in this chunk
        for h in handles {
            let _ = h.await;
        }

        // Small delay between chunks to avoid rate limiting
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    eprintln!();

    // 5. Write output
    let tooltips = Arc::try_unwrap(tooltips)
        .unwrap_or_else(|a| a.lock().unwrap().clone().into())
        .into_inner()
        .unwrap();

    // Ensure output directory exists
    if let Some(parent) = output_path.parent() {
        std::fs::create_dir_all(parent).ok();
    }

    let json = serde_json::to_string_pretty(&tooltips).expect("Failed to serialize");
    std::fs::write(&output_path, &json).expect("Failed to write output file");

    eprintln!(
        "\n✅ Done! Wrote {} spell tooltips to {}",
        tooltips.len(),
        output_path.display()
    );
    eprintln!("   ({} were new, {} were cached)", new_ids.len(), existing_count);
}
