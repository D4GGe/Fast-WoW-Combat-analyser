use serde::Serialize;

/// A parsed combat log file
#[derive(Debug, Serialize, Clone)]
pub struct CombatLogSummary {
    pub filename: String,
    pub log_version: Option<u32>,
    pub build_version: Option<String>,
    pub encounters: Vec<EncounterSummary>,
    pub zone_changes: Vec<ZoneChange>,
}

/// Summary of an encounter (boss fight or M+ key run)
#[derive(Debug, Serialize, Clone)]
pub struct EncounterSummary {
    pub index: usize,
    pub encounter_id: u64,
    pub name: String,
    pub difficulty_id: u32,
    pub difficulty_name: String,
    pub group_size: u32,
    pub success: bool,
    pub duration_secs: f64,
    pub start_time: String,
    pub end_time: String,
    pub key_level: Option<u32>,
    pub affixes: Vec<u32>,
    pub encounter_type: String,  // "boss", "mythic_plus"
    pub boss_encounters: Vec<BossEncounter>,  // bosses within a M+ key
    pub players: Vec<PlayerSummary>,
    pub deaths: Vec<DeathEvent>,
    pub segments: Vec<KeySegment>,
    /// Per-player buff uptimes: player_guid -> Vec<BuffUptime>
    pub buff_uptimes: std::collections::HashMap<String, Vec<BuffUptime>>,
    /// Per-enemy damage breakdown
    pub enemy_breakdowns: Vec<EnemyBreakdown>,
    /// Boss remaining HP percentage (0.0 for kills, e.g. 35.2 for 35.2% wipe)
    pub boss_hp_pct: Option<f64>,
    /// Boss max HP
    pub boss_max_hp: Option<u64>,
    /// Per-phase enemy breakdowns (from ENCOUNTER_PHASE_CHANGE events)
    pub phases: Vec<PhaseBreakdown>,
    /// Time-bucketed player damage: elapsed second -> player_guid -> damage
    pub time_bucketed_player_damage: std::collections::HashMap<u32, std::collections::HashMap<String, u64>>,
    /// Boss HP timeline: Vec of (elapsed_secs, hp_pct) sampled at damage events
    pub boss_hp_timeline: Vec<(f64, f64)>,
    /// Replay timeline: per-player HP snapshots sampled every 0.5s
    pub replay_timeline: Vec<HpSnapshot>,
    /// Boss positions on the map: (elapsed_secs, pos_x, pos_y)
    pub boss_positions: Vec<(f64, f64, f64)>,
}

/// Individual boss encounter within a M+ run
#[derive(Debug, Serialize, Clone)]
pub struct BossEncounter {
    pub name: String,
    pub encounter_id: u64,
    pub success: bool,
    pub duration_secs: f64,
    pub start_time: String,
    pub end_time: String,
}

/// Phase breakdown for a boss encounter
#[derive(Debug, Serialize, Clone)]
pub struct PhaseBreakdown {
    pub phase_id: u32,
    pub start_time_secs: f64,
    pub end_time_secs: f64,
    pub enemy_breakdowns: Vec<EnemyBreakdown>,
}

/// A segment within a M+ key (trash pack or boss fight)
#[derive(Debug, Serialize, Clone)]
pub struct KeySegment {
    pub segment_type: String,  // "trash" or "boss"
    pub name: String,
    pub index: usize,
    pub duration_secs: f64,
    pub start_time: String,
    pub end_time: String,
    pub players: Vec<PlayerSummary>,
    pub deaths: Vec<DeathEvent>,
    pub buff_uptimes: std::collections::HashMap<String, Vec<BuffUptime>>,
    pub enemy_breakdowns: Vec<EnemyBreakdown>,
    /// Individual pulls within a trash segment (empty for boss segments)
    pub pulls: Vec<TrashPull>,
}

/// An individual pull within a trash segment
#[derive(Debug, Serialize, Clone)]
pub struct TrashPull {
    pub pull_index: usize,
    pub duration_secs: f64,
    pub start_time_offset: f64,  // seconds from segment start
    pub enemies: Vec<PullEnemy>,
    pub players: Vec<PlayerSummary>,
    pub deaths: Vec<DeathEvent>,
}

/// An enemy within a specific pull
#[derive(Debug, Serialize, Clone)]
pub struct PullEnemy {
    pub name: String,
    pub damage_taken: u64,
    pub mob_type: String,
}

/// Per-player stats in an encounter
#[derive(Debug, Serialize, Clone)]
pub struct PlayerSummary {
    pub guid: String,
    pub name: String,
    pub class_name: String,
    pub spec_name: String,
    pub damage_done: u64,
    pub healing_done: u64,
    pub damage_taken: u64,
    pub deaths: u32,
    pub dps: f64,
    pub hps: f64,
    pub abilities: Vec<AbilityBreakdown>,
    pub heal_abilities: Vec<AbilityBreakdown>,
    pub damage_taken_abilities: Vec<AbilityBreakdown>,
}

/// Damage/healing breakdown per ability
#[derive(Debug, Serialize, Clone)]
pub struct AbilityBreakdown {
    pub spell_id: u64,
    pub spell_name: String,
    pub spell_school: u32,
    pub total_amount: u64,
    pub hit_count: u32,
    pub wowhead_url: String,
    pub targets: Vec<TargetBreakdown>,
}

/// Damage/healing per target for an ability
#[derive(Debug, Serialize, Clone)]
pub struct TargetBreakdown {
    pub target_name: String,
    pub amount: u64,
}

/// Per-enemy damage summary
#[derive(Debug, Serialize, Clone)]
pub struct EnemyBreakdown {
    pub target_name: String,
    pub total_damage: u64,
    pub kill_count: u32,
    pub mob_type: String,
    pub players: Vec<EnemyPlayerDamage>,
}

/// Player damage to a specific enemy
#[derive(Debug, Serialize, Clone)]
pub struct EnemyPlayerDamage {
    pub player_name: String,
    pub class_name: String,
    pub damage: u64,
}

/// Buff uptime data for a single buff on a single player
#[derive(Debug, Serialize, Clone)]
pub struct BuffUptime {
    pub spell_id: u64,
    pub spell_name: String,
    pub source_name: String,
    pub uptime_secs: f64,
    pub uptime_pct: f64,
    pub avg_stacks: f64,
    pub max_stacks: u32,
    pub wowhead_url: String,
    /// Timeline events for visualization
    pub timeline: Vec<BuffEvent>,
}

/// Individual buff state change for timeline
#[derive(Debug, Serialize, Clone)]
pub struct BuffEvent {
    /// Seconds into fight
    pub time: f64,
    /// "apply", "remove", "stack"
    pub event_type: String,
    pub stacks: u32,
}

/// A death event
#[derive(Debug, Serialize, Clone)]
pub struct DeathEvent {
    pub timestamp: String,
    pub player_name: String,
    pub player_guid: String,
    pub killing_blow_spell: Option<String>,
    pub killing_blow_source: Option<String>,
    pub killing_blow_amount: Option<u64>,
    pub overkill: Option<i64>,
    pub time_into_fight_secs: f64,
    pub recap: Vec<RecapEvent>,
}

/// A single event in a death recap timeline
#[derive(Debug, Serialize, Clone)]
pub struct RecapEvent {
    pub timestamp: String,
    pub time_into_fight_secs: f64,
    pub event_type: String,  // "damage", "healing", "buff_applied", "buff_removed"
    pub amount: u64,
    pub spell_name: String,
    pub spell_id: u64,
    pub source_name: String,
    pub wowhead_url: String,
    pub current_hp: u64,
    pub max_hp: u64,
}

/// A single HP snapshot for a player at a point in time (for replay)
#[derive(Debug, Serialize, Clone)]
pub struct HpSnapshot {
    pub time: f64,
    pub guid: String,
    pub name: String,
    pub class_name: String,
    pub current_hp: u64,
    pub max_hp: u64,
    pub is_dead: bool,
    pub pos_x: Option<f64>,
    pub pos_y: Option<f64>,
}

/// A zone change event
#[derive(Debug, Serialize, Clone)]
pub struct ZoneChange {
    pub timestamp: String,
    pub zone_id: u64,
    pub zone_name: String,
    pub difficulty_id: u32,
}

/// File listing info
#[derive(Debug, Serialize, Clone)]
pub struct LogFileInfo {
    pub filename: String,
    pub size_bytes: u64,
    pub size_display: String,
    pub date_str: String,
}

/// Difficulty ID to name mapping
pub fn difficulty_name(id: u32) -> String {
    match id {
        1 => "Normal".to_string(),
        2 => "Heroic".to_string(),
        8 => "Mythic Keystone".to_string(),
        14 => "Normal (Raid)".to_string(),
        15 => "Heroic (Raid)".to_string(),
        16 => "Mythic (Raid)".to_string(),
        17 => "Looking for Raid".to_string(),
        23 => "Mythic".to_string(),
        24 => "Timewalking".to_string(),
        _ => format!("Unknown ({})", id),
    }
}

/// Generate a Wowhead URL for a spell
pub fn wowhead_url(spell_id: u64) -> String {
    format!("https://www.wowhead.com/spell={}", spell_id)
}
