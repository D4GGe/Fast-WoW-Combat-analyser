use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::Path;

use crate::models::*;

/// Parse a WoW combat log file and return a summary
pub fn parse_combat_log(path: &Path) -> Result<CombatLogSummary, String> {
    let filename = path.file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("unknown")
        .to_string();

    let file = File::open(path).map_err(|e| format!("Failed to open file: {}", e))?;
    let reader = BufReader::with_capacity(1024 * 1024, file); // 1MB buffer

    let mut log_version: Option<u32> = None;
    let mut build_version: Option<String> = None;
    let mut zone_changes: Vec<ZoneChange> = Vec::new();
    let mut encounters: Vec<EncounterSummary> = Vec::new();

    // M+ key tracking
    let mut in_key = false;
    let mut key_start_time: Option<f64> = None;
    let mut key_start_str = String::new();
    let mut key_name = String::new();
    let mut key_zone_id: u64 = 0;
    let mut key_level: u32 = 0;
    let mut key_affixes: Vec<u32> = Vec::new();
    let mut key_boss_encounters: Vec<BossEncounter> = Vec::new();

    // Per-encounter/key tracking
    let mut tracker = EventTracker::new();

    // Segment tracking within M+ keys
    let mut key_segments: Vec<KeySegment> = Vec::new();
    let mut segment_tracker = EventTracker::new();
    let mut segment_start_secs: f64 = 0.0;
    let mut segment_start_str = String::new();
    let mut segment_boss_count: usize = 0;

    // Boss encounter sub-tracking (within a key)
    let mut in_boss = false;
    let mut boss_start_time: Option<f64> = None;
    let mut boss_start_str = String::new();
    let mut boss_name = String::new();
    let mut boss_id: u64 = 0;

    // Standalone boss encounters (raids, non-M+ dungeons)
    let mut standalone_boss = false;
    let mut standalone_start_time: Option<f64> = None;
    let mut standalone_start_str = String::new();
    let mut standalone_name = String::new();
    let mut standalone_id: u64 = 0;
    let mut standalone_difficulty: u32 = 0;
    let mut standalone_group_size: u32 = 0;
    let mut standalone_tracker = EventTracker::new();

    for line_result in reader.lines() {
        let line = match line_result {
            Ok(l) => l,
            Err(_) => continue,
        };

        let line = line.trim();
        if line.is_empty() {
            continue;
        }

        // Parse timestamp and event
        let (timestamp_str, event_part) = match split_timestamp_event(line) {
            Some(v) => v,
            None => continue,
        };

        let timestamp_secs = parse_timestamp_to_secs(timestamp_str);
        let fields: Vec<&str> = parse_csv_fields(event_part);

        if fields.is_empty() {
            continue;
        }

        let event_type = fields[0];

        match event_type {
            "COMBAT_LOG_VERSION" => {
                if fields.len() > 1 {
                    log_version = fields[1].parse().ok();
                }
                if fields.len() > 5 {
                    build_version = Some(fields[5].trim_matches('"').to_string());
                }
            }
            "COMBATANT_INFO" => {
                if fields.len() > 25 {
                    let guid = fields[1].to_string();
                    if let Ok(spec_id) = fields[25].parse::<u32>() {
                        if spec_id > 0 {
                            tracker.player_specs.insert(guid.clone(), spec_id);
                            segment_tracker.player_specs.insert(guid.clone(), spec_id);
                            standalone_tracker.player_specs.insert(guid, spec_id);
                        }
                    }
                }
            }
            "ZONE_CHANGE" => {
                if fields.len() >= 4 {
                    zone_changes.push(ZoneChange {
                        timestamp: timestamp_str.to_string(),
                        zone_id: fields[1].parse().unwrap_or(0),
                        zone_name: unquote(fields[2]),
                        difficulty_id: fields[3].parse().unwrap_or(0),
                    });
                }
            }
            "CHALLENGE_MODE_START" => {
                // Start tracking a whole M+ key as one encounter
                in_key = true;
                key_start_time = Some(timestamp_secs);
                key_start_str = timestamp_str.to_string();
                key_name = fields.get(1).map(|s| unquote(s)).unwrap_or_default();
                key_zone_id = fields.get(2).and_then(|s| s.parse().ok()).unwrap_or(0);
                key_level = fields.get(4).and_then(|s| s.parse().ok()).unwrap_or(0);

                // Parse affixes from bracket-enclosed list like [9,10,147]
                key_affixes = Vec::new();
                if let Some(affix_str) = fields.get(5) {
                    let cleaned = affix_str.trim_matches(|c| c == '[' || c == ']');
                    for part in cleaned.split(',') {
                        if let Ok(v) = part.trim().parse::<u32>() {
                            key_affixes.push(v);
                        }
                    }
                }

                key_boss_encounters.clear();
                key_segments.clear();
                tracker = EventTracker::new();
                segment_tracker = EventTracker::new();
                segment_start_secs = timestamp_secs;
                segment_start_str = timestamp_str.to_string();
                segment_boss_count = 0;
            }
            "CHALLENGE_MODE_END" => {
                if in_key {
                    let success = fields.get(2).and_then(|s| s.parse::<u32>().ok()).unwrap_or(0) == 1;
                    let end_time = timestamp_secs;
                    let duration = end_time - key_start_time.unwrap_or(end_time);

                    // Flush any trailing trash segment after the last boss
                    let trailing_duration = timestamp_secs - segment_start_secs;
                    if trailing_duration > 0.5 {
                        let trailing_players = segment_tracker.build_player_summaries(trailing_duration);
                        key_segments.push(KeySegment {
                            segment_type: "trash".to_string(),
                            name: format!("Trash {}", segment_boss_count + 1),
                            index: key_segments.len(),
                            duration_secs: trailing_duration,
                            start_time: segment_start_str.clone(),
                            end_time: timestamp_str.to_string(),
                            players: trailing_players,
                            deaths: segment_tracker.death_events.clone(),
                            buff_uptimes: segment_tracker.build_buff_uptimes(trailing_duration),
                            enemy_breakdowns: segment_tracker.build_enemy_breakdowns(
                                &key_boss_encounters.iter().map(|b| b.name.clone()).collect::<Vec<_>>()
                            ),
                        });
                    }

                    let players = tracker.build_player_summaries(duration);

                    encounters.push(EncounterSummary {
                        index: encounters.len(),
                        encounter_id: key_zone_id,
                        name: format!("{} +{}", key_name, key_level),
                        difficulty_id: 8, // Mythic Keystone
                        difficulty_name: format!("Mythic +{}", key_level),
                        group_size: 5,
                        success,
                        duration_secs: duration,
                        start_time: key_start_str.clone(),
                        end_time: timestamp_str.to_string(),
                        key_level: Some(key_level),
                        affixes: key_affixes.clone(),
                        encounter_type: "mythic_plus".to_string(),
                        boss_encounters: key_boss_encounters.clone(),
                        players,
                        deaths: tracker.death_events.clone(),
                        segments: key_segments.clone(),
                        buff_uptimes: tracker.build_buff_uptimes(duration),
                        enemy_breakdowns: tracker.build_enemy_breakdowns(
                            &key_boss_encounters.iter().map(|b| b.name.clone()).collect::<Vec<_>>()
                        ),
                        boss_hp_pct: None,
                        boss_max_hp: None,
                        phases: Vec::new(),
                        time_bucketed_player_damage: HashMap::new(),
                        boss_hp_timeline: Vec::new(),
                    });

                    in_key = false;
                    in_boss = false;
                }
            }
            "ENCOUNTER_START" => {
                let enc_id = fields.get(1).and_then(|s| s.parse().ok()).unwrap_or(0);
                let enc_name = fields.get(2).map(|s| unquote(s)).unwrap_or_default();
                let difficulty = fields.get(3).and_then(|s| s.parse::<u32>().ok()).unwrap_or(0);
                let group_size = fields.get(4).and_then(|s| s.parse::<u32>().ok()).unwrap_or(0);

                if in_key {
                    // Boss within a M+ key — flush current trash segment first
                    let trash_duration = timestamp_secs - segment_start_secs;
                    if trash_duration > 0.5 {
                        let trash_players = segment_tracker.build_player_summaries(trash_duration);
                        key_segments.push(KeySegment {
                            segment_type: "trash".to_string(),
                            name: format!("Trash {}", segment_boss_count + 1),
                            index: key_segments.len(),
                            duration_secs: trash_duration,
                            start_time: segment_start_str.clone(),
                            end_time: timestamp_str.to_string(),
                            players: trash_players,
                            deaths: segment_tracker.death_events.clone(),
                            buff_uptimes: segment_tracker.build_buff_uptimes(trash_duration),
                            enemy_breakdowns: segment_tracker.build_enemy_breakdowns(
                                &key_boss_encounters.iter().map(|b| b.name.clone()).collect::<Vec<_>>()
                            ),
                        });
                    }
                    segment_tracker = EventTracker::new_with_context(&tracker);
                    segment_start_secs = timestamp_secs;
                    segment_start_str = timestamp_str.to_string();

                    // Track the boss sub-encounter
                    in_boss = true;
                    boss_start_time = Some(timestamp_secs);
                    boss_start_str = timestamp_str.to_string();
                    boss_name = enc_name;
                    boss_id = enc_id;
                } else {
                    // Standalone boss encounter (raid or non-M+ dungeon)
                    standalone_boss = true;
                    standalone_start_time = Some(timestamp_secs);
                    standalone_start_str = timestamp_str.to_string();
                    standalone_name = enc_name;
                    standalone_id = enc_id;
                    standalone_difficulty = difficulty;
                    standalone_group_size = group_size;
                    standalone_tracker = EventTracker::new();
                    standalone_tracker.boss_encounter_name = standalone_name.clone();
                    standalone_tracker.encounter_start_secs = timestamp_secs;
                }
            }
            "ENCOUNTER_PHASE_CHANGE" => {
                // Blizzard's native phase change event
                // Format: ENCOUNTER_PHASE_CHANGE,phaseNumber
                let phase_id: u32 = fields.get(1).and_then(|s| s.parse().ok()).unwrap_or(1);
                if standalone_boss {
                    standalone_tracker.current_phase = phase_id;
                    standalone_tracker.phase_transitions.push((timestamp_secs, phase_id));
                }
                if in_key && in_boss {
                    segment_tracker.current_phase = phase_id;
                    segment_tracker.phase_transitions.push((timestamp_secs, phase_id));
                    tracker.current_phase = phase_id;
                    tracker.phase_transitions.push((timestamp_secs, phase_id));
                }
            }
            "ENCOUNTER_END" => {
                let success = fields.get(5).and_then(|s| s.parse::<u32>().ok()).unwrap_or(0) == 1;

                if in_key && in_boss {
                    // Boss ended within M+ — log it as a sub-encounter
                    let boss_duration = timestamp_secs - boss_start_time.unwrap_or(timestamp_secs);
                    key_boss_encounters.push(BossEncounter {
                        name: boss_name.clone(),
                        encounter_id: boss_id,
                        success,
                        duration_secs: boss_duration,
                        start_time: boss_start_str.clone(),
                        end_time: timestamp_str.to_string(),
                    });

                    // Flush boss segment
                    let boss_seg_duration = timestamp_secs - segment_start_secs;
                    let boss_players = segment_tracker.build_player_summaries(boss_seg_duration);
                    segment_boss_count += 1;
                    key_segments.push(KeySegment {
                        segment_type: "boss".to_string(),
                        name: boss_name.clone(),
                        index: key_segments.len(),
                        duration_secs: boss_seg_duration,
                        start_time: segment_start_str.clone(),
                        end_time: timestamp_str.to_string(),
                        players: boss_players,
                        deaths: segment_tracker.death_events.clone(),
                        buff_uptimes: segment_tracker.build_buff_uptimes(boss_seg_duration),
                        enemy_breakdowns: segment_tracker.build_enemy_breakdowns(&[boss_name.clone()]),
                    });
                    segment_tracker = EventTracker::new_with_context(&tracker);
                    segment_start_secs = timestamp_secs;
                    segment_start_str = timestamp_str.to_string();

                    in_boss = false;
                } else if standalone_boss {
                    // Standalone boss encounter ended
                    let duration = timestamp_secs - standalone_start_time.unwrap_or(timestamp_secs);
                    let players = standalone_tracker.build_player_summaries(duration);

                    encounters.push(EncounterSummary {
                        index: encounters.len(),
                        encounter_id: standalone_id,
                        name: standalone_name.clone(),
                        difficulty_id: standalone_difficulty,
                        difficulty_name: difficulty_name(standalone_difficulty),
                        group_size: standalone_group_size,
                        success,
                        duration_secs: duration,
                        start_time: standalone_start_str.clone(),
                        end_time: timestamp_str.to_string(),
                        key_level: None,
                        affixes: Vec::new(),
                        encounter_type: "boss".to_string(),
                        boss_encounters: Vec::new(),
                        players,
                        deaths: standalone_tracker.death_events.clone(),
                        segments: Vec::new(),
                        buff_uptimes: standalone_tracker.build_buff_uptimes(duration),
                        enemy_breakdowns: standalone_tracker.build_enemy_breakdowns(
                            &[standalone_name.clone()]
                        ),
                        boss_hp_pct: standalone_tracker.last_creature_hp.get(&standalone_name)
                            .map(|(cur, max)| if *max > 0 { (*cur as f64 / *max as f64 * 100.0) } else { 0.0 }),
                        boss_max_hp: standalone_tracker.last_creature_hp.get(&standalone_name)
                            .map(|(_, max)| *max),
                        phases: standalone_tracker.build_phase_breakdowns(
                            standalone_start_time.unwrap_or(timestamp_secs),
                            timestamp_secs,
                            &[standalone_name.clone()]
                        ),
                        time_bucketed_player_damage: standalone_tracker.time_bucketed_player_damage.clone(),
                        boss_hp_timeline: standalone_tracker.boss_hp_timeline.clone(),
                    });

                    standalone_boss = false;
                }
            }
            _ => {
                // Process combat events
                if in_key {
                    // During M+ key — track everything for the overall key AND the current segment
                    process_combat_event(event_type, &fields, timestamp_str, timestamp_secs,
                        key_start_time.unwrap_or(0.0), &mut tracker);
                    process_combat_event(event_type, &fields, timestamp_str, timestamp_secs,
                        segment_start_secs, &mut segment_tracker);
                } else if standalone_boss {
                    // During standalone boss encounter
                    process_combat_event(event_type, &fields, timestamp_str, timestamp_secs,
                        standalone_start_time.unwrap_or(0.0), &mut standalone_tracker);
                }
            }
        }
    }

    Ok(CombatLogSummary {
        filename,
        log_version,
        build_version,
        encounters,
        zone_changes,
    })
}

/// Tracks damage/healing/deaths during an encounter or key
struct EventTracker {
    damage_by_player: HashMap<String, HashMap<u64, (String, u32, u64, u32)>>,
    healing_by_player: HashMap<String, HashMap<u64, (String, u32, u64, u32)>>,
    damage_taken_by_player: HashMap<String, u64>,
    player_names: HashMap<String, String>,
    death_events: Vec<DeathEvent>,
    player_death_counts: HashMap<String, u32>,
    last_damage_to: HashMap<String, (String, String, u64, i64)>,
    /// Recent damage/heal events per player for death recap (last 15 events)
    recent_events: HashMap<String, Vec<RecapEvent>>,
    /// Player spec IDs from COMBATANT_INFO
    player_specs: HashMap<String, u32>,
    /// Per-target damage: player_guid -> spell_id -> target_name -> amount
    damage_targets: HashMap<String, HashMap<u64, HashMap<String, u64>>>,
    /// Per-target healing: player_guid -> spell_id -> target_name -> amount
    healing_targets: HashMap<String, HashMap<u64, HashMap<String, u64>>>,
    /// Aura events: player_guid -> spell_id -> Vec<(time_secs, event: "apply"/"remove"/"dose", stacks)>
    raw_aura_events: HashMap<String, HashMap<u64, Vec<(f64, String, u32)>>>,
    /// Active aura stacks: player_guid -> spell_id -> current_stacks
    active_aura_stacks: HashMap<String, HashMap<u64, u32>>,
    /// Spell names for aura: spell_id -> spell_name
    aura_spell_names: HashMap<u64, String>,
    /// Aura sources: (player_guid, spell_id) -> source_name
    aura_sources: HashMap<(String, u64), String>,
    /// Kill counts per target name
    kill_counts: HashMap<String, u32>,
    /// Creature type from GUID: target_name -> guid_type ("Creature", "Vehicle", "Pet", etc.)
    creature_types: HashMap<String, String>,
    /// Last known HP for non-player targets: dest_name -> (currentHP, maxHP)
    last_creature_hp: HashMap<String, (u64, u64)>,
    /// Current encounter phase (from ENCOUNTER_PHASE_CHANGE events)
    current_phase: u32,
    /// Phase transitions: (timestamp_secs, phase_id)
    phase_transitions: Vec<(f64, u32)>,
    /// Per-phase per-target damage: phase_id -> target_name -> total_damage
    phase_damage_targets: HashMap<u32, HashMap<String, u64>>,
    /// Creature types per phase for proper enemy labeling
    phase_creature_types: HashMap<u32, HashMap<String, String>>,
    /// Boss encounter name for HP tracking
    boss_encounter_name: String,
    /// Current boss HP percentage (0.0-100.0), updated from damage events to boss
    current_boss_hp_pct: f64,
    /// The highest maxHP seen among creatures — we treat this creature as the boss
    boss_max_hp_seen: u64,
    /// Encounter start time in seconds (for time-based bucketing)
    encounter_start_secs: f64,
    /// Time-bucketed player damage: elapsed second -> player_guid -> damage
    time_bucketed_player_damage: HashMap<u32, HashMap<String, u64>>,
    /// Boss HP timeline: (elapsed_secs, hp_pct) sampled when boss takes damage
    boss_hp_timeline: Vec<(f64, f64)>,
}

impl EventTracker {
    fn new() -> Self {
        EventTracker {
            damage_by_player: HashMap::new(),
            healing_by_player: HashMap::new(),
            damage_taken_by_player: HashMap::new(),
            player_names: HashMap::new(),
            death_events: Vec::new(),
            player_death_counts: HashMap::new(),
            last_damage_to: HashMap::new(),
            recent_events: HashMap::new(),
            player_specs: HashMap::new(),
            damage_targets: HashMap::new(),
            healing_targets: HashMap::new(),
            raw_aura_events: HashMap::new(),
            active_aura_stacks: HashMap::new(),
            aura_spell_names: HashMap::new(),
            aura_sources: HashMap::new(),
            kill_counts: HashMap::new(),
            creature_types: HashMap::new(),
            last_creature_hp: HashMap::new(),
            current_phase: 1,
            phase_transitions: Vec::new(),
            phase_damage_targets: HashMap::new(),
            phase_creature_types: HashMap::new(),
            boss_encounter_name: String::new(),
            current_boss_hp_pct: 100.0,
            boss_max_hp_seen: 0,
            encounter_start_secs: 0.0,
            time_bucketed_player_damage: HashMap::new(),
            boss_hp_timeline: Vec::new(),
        }
    }

    /// Create a new tracker, carrying over player identity info from another tracker
    fn new_with_context(other: &EventTracker) -> Self {
        let mut t = EventTracker::new();
        t.player_specs = other.player_specs.clone();
        t.player_names = other.player_names.clone();
        t
    }

    fn push_recap_event(&mut self, guid: &str, event: RecapEvent) {
        let events = self.recent_events.entry(guid.to_string()).or_default();
        events.push(event);
        // Periodically prune old events to avoid unbounded memory
        // (trim to last 60 seconds by timestamp to keep a comfortable buffer)
        if events.len() > 200 {
            let latest = events.last().map(|e| e.time_into_fight_secs).unwrap_or(0.0);
            events.retain(|e| latest - e.time_into_fight_secs < 60.0);
        }
    }

    fn take_recap(&mut self, guid: &str, death_time: f64) -> Vec<RecapEvent> {
        let events = self.recent_events.remove(guid).unwrap_or_default();
        // Keep only events from the last 15 seconds before death,
        // and filter out buff_removed events within 0.5s of death (mass buff removal on death)
        events.into_iter()
            .filter(|e| {
                let in_window = death_time - e.time_into_fight_secs <= 15.0 && e.time_into_fight_secs <= death_time;
                let is_death_buff_removal = e.event_type == "buff_removed"
                    && (death_time - e.time_into_fight_secs).abs() < 0.5;
                in_window && !is_death_buff_removal
            })
            .collect()
    }

    fn build_player_summaries(&self, duration: f64) -> Vec<PlayerSummary> {
        let mut all_guids: std::collections::HashSet<String> = std::collections::HashSet::new();
        for g in self.damage_by_player.keys() { all_guids.insert(g.clone()); }
        for g in self.healing_by_player.keys() { all_guids.insert(g.clone()); }

        let mut players: Vec<PlayerSummary> = Vec::new();

        for guid in &all_guids {
            if !guid.starts_with("Player-") {
                continue;
            }
            let name = self.player_names.get(guid).cloned().unwrap_or_else(|| "Unknown".to_string());
            let (class_name, spec_name) = self.player_specs.get(guid)
                .and_then(|id| spec_info(*id))
                .map(|(c, s, _)| (c.to_string(), s.to_string()))
                .unwrap_or_else(|| (String::new(), String::new()));

            let mut total_damage: u64 = 0;
            let mut damage_abilities: Vec<AbilityBreakdown> = Vec::new();
            if let Some(spells) = self.damage_by_player.get(guid) {
                let player_targets = self.damage_targets.get(guid);
                for (spell_id, (spell_name, school, total, hits)) in spells {
                    total_damage += total;
                    // Build target breakdown for this spell
                    let mut targets: Vec<TargetBreakdown> = Vec::new();
                    if let Some(pt) = player_targets {
                        if let Some(spell_targets) = pt.get(spell_id) {
                            for (tname, tamount) in spell_targets {
                                targets.push(TargetBreakdown {
                                    target_name: tname.clone(),
                                    amount: *tamount,
                                });
                            }
                        }
                    }
                    targets.sort_by(|a, b| b.amount.cmp(&a.amount));
                    damage_abilities.push(AbilityBreakdown {
                        spell_id: *spell_id,
                        spell_name: spell_name.clone(),
                        spell_school: *school,
                        total_amount: *total,
                        hit_count: *hits,
                        wowhead_url: wowhead_url(*spell_id),
                        targets,
                    });
                }
            }
            damage_abilities.sort_by(|a, b| b.total_amount.cmp(&a.total_amount));

            let mut total_healing: u64 = 0;
            let mut heal_abilities: Vec<AbilityBreakdown> = Vec::new();
            if let Some(spells) = self.healing_by_player.get(guid) {
                let player_targets = self.healing_targets.get(guid);
                for (spell_id, (spell_name, school, total, hits)) in spells {
                    total_healing += total;
                    let mut targets: Vec<TargetBreakdown> = Vec::new();
                    if let Some(pt) = player_targets {
                        if let Some(spell_targets) = pt.get(spell_id) {
                            for (tname, tamount) in spell_targets {
                                targets.push(TargetBreakdown {
                                    target_name: tname.clone(),
                                    amount: *tamount,
                                });
                            }
                        }
                    }
                    targets.sort_by(|a, b| b.amount.cmp(&a.amount));
                    heal_abilities.push(AbilityBreakdown {
                        spell_id: *spell_id,
                        spell_name: spell_name.clone(),
                        spell_school: *school,
                        total_amount: *total,
                        hit_count: *hits,
                        wowhead_url: wowhead_url(*spell_id),
                        targets,
                    });
                }
            }
            heal_abilities.sort_by(|a, b| b.total_amount.cmp(&a.total_amount));

            let total_taken = self.damage_taken_by_player.get(guid).copied().unwrap_or(0);
            let deaths = self.player_death_counts.get(guid).copied().unwrap_or(0);
            let dps = if duration > 0.0 { total_damage as f64 / duration } else { 0.0 };
            let hps = if duration > 0.0 { total_healing as f64 / duration } else { 0.0 };

            players.push(PlayerSummary {
                guid: guid.clone(),
                name,
                class_name,
                spec_name,
                damage_done: total_damage,
                healing_done: total_healing,
                damage_taken: total_taken,
                deaths,
                dps,
                hps,
                abilities: damage_abilities,
                heal_abilities,
            });
        }
        players.sort_by(|a, b| b.damage_done.cmp(&a.damage_done));
        players
    }

    /// Build buff uptime data for all players
    fn build_buff_uptimes(&self, duration: f64) -> HashMap<String, Vec<BuffUptime>> {
        let mut result: HashMap<String, Vec<BuffUptime>> = HashMap::new();

        for (guid, spells) in &self.raw_aura_events {
            let mut player_uptimes: Vec<BuffUptime> = Vec::new();

            for (spell_id, events) in spells {
                let spell_name = self.aura_spell_names.get(spell_id)
                    .cloned()
                    .unwrap_or_else(|| format!("Spell {}", spell_id));

                let mut timeline: Vec<BuffEvent> = Vec::new();
                let mut total_uptime = 0.0_f64;
                let mut weighted_stacks = 0.0_f64;
                let mut max_stacks: u32 = 0;
                let mut is_active = false;
                let mut active_since = 0.0_f64;
                let mut current_stacks: u32 = 0;

                for (time, etype, stacks) in events {
                    timeline.push(BuffEvent {
                        time: *time,
                        event_type: etype.clone(),
                        stacks: *stacks,
                    });

                    match etype.as_str() {
                        "apply" => {
                            if is_active {
                                // Close previous interval
                                let segment_dur = time - active_since;
                                total_uptime += segment_dur;
                                weighted_stacks += current_stacks as f64 * segment_dur;
                            }
                            is_active = true;
                            active_since = *time;
                            current_stacks = *stacks;
                            if *stacks > max_stacks { max_stacks = *stacks; }
                        }
                        "remove" => {
                            if is_active {
                                let segment_dur = time - active_since;
                                total_uptime += segment_dur;
                                weighted_stacks += current_stacks as f64 * segment_dur;
                            }
                            is_active = false;
                            current_stacks = 0;
                        }
                        "stack" => {
                            if is_active {
                                let segment_dur = time - active_since;
                                total_uptime += segment_dur;
                                weighted_stacks += current_stacks as f64 * segment_dur;
                                active_since = *time;
                            }
                            current_stacks = *stacks;
                            if *stacks > max_stacks { max_stacks = *stacks; }
                        }
                        _ => {}
                    }
                }

                // Close any buff still active at encounter end
                if is_active && duration > active_since {
                    let remaining = duration - active_since;
                    total_uptime += remaining;
                    weighted_stacks += current_stacks as f64 * remaining;
                }

                if total_uptime < 0.01 { continue; }

                let uptime_pct = if duration > 0.0 { (total_uptime / duration * 100.0).min(100.0) } else { 0.0 };
                let avg_stacks = if total_uptime > 0.0 { weighted_stacks / total_uptime } else { 0.0 };

                player_uptimes.push(BuffUptime {
                    spell_id: *spell_id,
                    spell_name,
                    source_name: self.aura_sources.get(&(guid.clone(), *spell_id))
                        .cloned().unwrap_or_default(),
                    uptime_secs: total_uptime,
                    uptime_pct,
                    avg_stacks,
                    max_stacks,
                    wowhead_url: wowhead_url(*spell_id),
                    timeline,
                });
            }

            player_uptimes.sort_by(|a, b| b.uptime_pct.partial_cmp(&a.uptime_pct).unwrap_or(std::cmp::Ordering::Equal));
            result.insert(guid.clone(), player_uptimes);
        }

        result
    }

    fn build_enemy_breakdowns(&self, boss_names: &[String]) -> Vec<EnemyBreakdown> {
        // Invert: damage_targets is player_guid -> spell_id -> target_name -> amount
        // We want: target_name -> player_guid -> total_damage
        let mut target_map: HashMap<String, HashMap<String, u64>> = HashMap::new();

        for (player_guid, spells) in &self.damage_targets {
            for (_spell_id, targets) in spells {
                for (target_name, amount) in targets {
                    *target_map.entry(target_name.clone()).or_default()
                        .entry(player_guid.clone()).or_default() += amount;
                }
            }
        }

        // Lowercase boss names for matching
        let boss_names_lower: Vec<String> = boss_names.iter().map(|n| n.to_lowercase()).collect();

        let mut breakdowns: Vec<EnemyBreakdown> = target_map.into_iter().map(|(target_name, players_map)| {
            let total_damage: u64 = players_map.values().sum();
            let mut players: Vec<EnemyPlayerDamage> = players_map.into_iter().map(|(guid, damage)| {
                let player_name = self.player_names.get(&guid).cloned().unwrap_or_else(|| guid.clone());
                let spec_id = self.player_specs.get(&guid).copied().unwrap_or(0);
                let class_name = spec_info(spec_id).map(|(c, _, _)| c.to_string()).unwrap_or_default();
                EnemyPlayerDamage { player_name, class_name, damage }
            }).collect();
            players.sort_by(|a, b| b.damage.cmp(&a.damage));
            EnemyBreakdown { target_name, total_damage, kill_count: 0, mob_type: String::new(), players }
        }).collect();

        // Enrich with kill counts and mob types
        for enemy in &mut breakdowns {
            enemy.kill_count = self.kill_counts.get(&enemy.target_name).copied().unwrap_or(0);

            // Classify mob type
            let creature_guid_type = self.creature_types.get(&enemy.target_name)
                .map(|s| s.as_str()).unwrap_or("Unknown");
            let name_lower = enemy.target_name.to_lowercase();

            if creature_guid_type == "Pet" {
                enemy.mob_type = "Pet".to_string();
            } else if boss_names_lower.iter().any(|bn| name_lower.contains(bn) || bn.contains(&name_lower)) {
                enemy.mob_type = "Boss".to_string();
            } else {
                enemy.mob_type = "Trash".to_string();
            }
        }

        breakdowns.sort_by(|a, b| b.total_damage.cmp(&a.total_damage));
        breakdowns
    }

    /// Build per-phase enemy breakdowns from ENCOUNTER_PHASE_CHANGE events
    fn build_phase_breakdowns(&self, enc_start_secs: f64, enc_end_secs: f64, boss_names: &[String]) -> Vec<PhaseBreakdown> {
        // Only build phases if we actually saw phase change events
        if self.phase_transitions.is_empty() {
            return Vec::new();
        }

        let boss_names_lower: Vec<String> = boss_names.iter().map(|n| n.to_lowercase()).collect();

        // Collect all unique phases in order
        let mut phase_ids: Vec<u32> = Vec::new();
        // Phase 1 is implicit at the start
        phase_ids.push(1);
        for &(_, phase_id) in &self.phase_transitions {
            if !phase_ids.contains(&phase_id) {
                phase_ids.push(phase_id);
            }
        }

        // Build time ranges for each phase
        let mut phases: Vec<PhaseBreakdown> = Vec::new();
        for (idx, &phase_id) in phase_ids.iter().enumerate() {
            let start = if phase_id == 1 {
                0.0
            } else {
                self.phase_transitions.iter()
                    .find(|&&(_, pid)| pid == phase_id)
                    .map(|&(ts, _)| ts - enc_start_secs)
                    .unwrap_or(0.0)
            };

            let end = if idx + 1 < phase_ids.len() {
                let next_phase = phase_ids[idx + 1];
                self.phase_transitions.iter()
                    .find(|&&(_, pid)| pid == next_phase)
                    .map(|&(ts, _)| ts - enc_start_secs)
                    .unwrap_or(enc_end_secs - enc_start_secs)
            } else {
                enc_end_secs - enc_start_secs
            };

            // Build enemy breakdowns for this phase
            let enemies = if let Some(phase_targets) = self.phase_damage_targets.get(&phase_id) {
                let mut breakdowns: Vec<EnemyBreakdown> = phase_targets.iter().map(|(target_name, &total_damage)| {
                    let name_lower = target_name.to_lowercase();
                    let creature_type = self.phase_creature_types
                        .get(&phase_id)
                        .and_then(|m| m.get(target_name))
                        .map(|s| s.as_str())
                        .unwrap_or("Unknown");
                    let mob_type = if creature_type == "Pet" {
                        "Pet".to_string()
                    } else if boss_names_lower.iter().any(|bn| name_lower.contains(bn) || bn.contains(&name_lower)) {
                        "Boss".to_string()
                    } else {
                        "Trash".to_string()
                    };
                    EnemyBreakdown {
                        target_name: target_name.clone(),
                        total_damage,
                        kill_count: 0,
                        mob_type,
                        players: Vec::new(), // No per-player breakdown for phases
                    }
                }).collect();
                breakdowns.sort_by(|a, b| b.total_damage.cmp(&a.total_damage));
                breakdowns
            } else {
                Vec::new()
            };

            phases.push(PhaseBreakdown {
                phase_id,
                start_time_secs: start,
                end_time_secs: end,
                enemy_breakdowns: enemies,
            });
        }

        phases
    }
}

/// Process a single combat event
fn process_combat_event(
    event_type: &str,
    fields: &[&str],
    timestamp_str: &str,
    timestamp_secs: f64,
    start_secs: f64,
    tracker: &mut EventTracker,
) {
    let source_guid = fields.get(1).map(|s| s.to_string()).unwrap_or_default();
    let source_name = fields.get(2).map(|s| unquote(s)).unwrap_or_default();
    let dest_guid = fields.get(5).map(|s| s.to_string()).unwrap_or_default();
    let dest_name = fields.get(6).map(|s| unquote(s)).unwrap_or_default();

    // Register player names
    if source_guid.starts_with("Player-") && !source_name.is_empty() {
        tracker.player_names.insert(source_guid.clone(), source_name.clone());
    }
    if dest_guid.starts_with("Player-") && !dest_name.is_empty() {
        tracker.player_names.insert(dest_guid.clone(), dest_name.clone());
    }

    match event_type {
        "SPELL_DAMAGE" | "SPELL_PERIODIC_DAMAGE" | "RANGE_DAMAGE" | "SPELL_DAMAGE_SUPPORT" => {
            let spell_id: u64 = fields.get(9).and_then(|s| s.parse().ok()).unwrap_or(0);
            let spell_name = fields.get(10).map(|s| unquote(s)).unwrap_or_default();
            let spell_school: u32 = fields.get(11).and_then(|s| parse_hex_or_dec(s)).unwrap_or(0);
            let amount = find_damage_amount(fields, 31);

            if source_guid.starts_with("Player-") && amount > 0 {
                let entry = tracker.damage_by_player
                    .entry(source_guid.clone())
                    .or_default()
                    .entry(spell_id)
                    .or_insert_with(|| (spell_name.clone(), spell_school, 0, 0));
                entry.2 += amount;
                entry.3 += 1;
                // Track per-target
                *tracker.damage_targets
                    .entry(source_guid.clone()).or_default()
                    .entry(spell_id).or_default()
                    .entry(dest_name.clone()).or_default() += amount;
                // Bucket player damage by elapsed second
                if tracker.encounter_start_secs > 0.0 {
                    let elapsed = (timestamp_secs - tracker.encounter_start_secs).max(0.0) as u32;
                    *tracker.time_bucketed_player_damage
                        .entry(elapsed).or_default()
                        .entry(source_guid.clone()).or_default() += amount;
                }
                // Record creature type from GUID for enemies tab
                if !dest_guid.starts_with("Player-") && !dest_name.is_empty() {
                    let guid_type = if dest_guid.starts_with("Creature-") { "Creature" }
                        else if dest_guid.starts_with("Vehicle-") { "Vehicle" }
                        else if dest_guid.starts_with("Pet-") { "Pet" }
                        else { "Other" };
                    tracker.creature_types.entry(dest_name.clone()).or_insert_with(|| guid_type.to_string());
                    // Track creature HP from advanced info (fields 14=currentHP, 15=maxHP)
                    let c_hp: u64 = fields.get(14).and_then(|s| s.parse().ok()).unwrap_or(0);
                    let m_hp: u64 = fields.get(15).and_then(|s| s.parse().ok()).unwrap_or(0);
                    if m_hp > 0 {
                        tracker.last_creature_hp.insert(dest_name.clone(), (c_hp, m_hp));
                        // Update boss HP % — track the creature with the highest maxHP as the boss
                        if !tracker.boss_encounter_name.is_empty() && m_hp >= tracker.boss_max_hp_seen {
                            tracker.boss_max_hp_seen = m_hp;
                            tracker.current_boss_hp_pct = c_hp as f64 / m_hp as f64 * 100.0;
                            // Record boss HP timeline point
                            if tracker.encounter_start_secs > 0.0 {
                                let elapsed = timestamp_secs - tracker.encounter_start_secs;
                                tracker.boss_hp_timeline.push((elapsed, tracker.current_boss_hp_pct));
                            }
                        }
                    }
                    // Track per-phase damage to enemies
                    *tracker.phase_damage_targets
                        .entry(tracker.current_phase).or_default()
                        .entry(dest_name.clone()).or_default() += amount;
                    tracker.phase_creature_types
                        .entry(tracker.current_phase).or_default()
                        .entry(dest_name.clone()).or_insert_with(|| guid_type.to_string());

                }
            }

            if dest_guid.starts_with("Player-") && amount > 0 {
                *tracker.damage_taken_by_player.entry(dest_guid.clone()).or_insert(0) += amount;
                let overkill: i64 = fields.get(33).and_then(|s| s.parse().ok()).unwrap_or(-1);
                tracker.last_damage_to.insert(dest_guid.clone(), (spell_name.clone(), source_name.clone(), amount, overkill));
                // HP from advanced info: for SPELL events, currentHP at [14], maxHP at [15]
                let current_hp: u64 = fields.get(14).and_then(|s| s.parse().ok()).unwrap_or(0);
                let max_hp: u64 = fields.get(15).and_then(|s| s.parse().ok()).unwrap_or(0);
                tracker.push_recap_event(&dest_guid, RecapEvent {
                    timestamp: timestamp_str.to_string(),
                    time_into_fight_secs: timestamp_secs - start_secs,
                    event_type: "damage".to_string(),
                    amount,
                    spell_name,
                    spell_id,
                    source_name: source_name.clone(),
                    wowhead_url: wowhead_url(spell_id),
                    current_hp,
                    max_hp,
                });
            }
        }
        "SWING_DAMAGE" | "SWING_DAMAGE_LANDED" => {
            let amount = find_damage_amount(fields, 28);

            if source_guid.starts_with("Player-") && amount > 0 {
                let entry = tracker.damage_by_player
                    .entry(source_guid.clone())
                    .or_default()
                    .entry(0)
                    .or_insert_with(|| ("Melee".to_string(), 1, 0, 0));
                entry.2 += amount;
                entry.3 += 1;
                // Track per-target
                *tracker.damage_targets
                    .entry(source_guid.clone()).or_default()
                    .entry(0u64).or_default()
                    .entry(dest_name.clone()).or_default() += amount;
                // Bucket player damage by elapsed second
                if tracker.encounter_start_secs > 0.0 {
                    let elapsed = (timestamp_secs - tracker.encounter_start_secs).max(0.0) as u32;
                    *tracker.time_bucketed_player_damage
                        .entry(elapsed).or_default()
                        .entry(source_guid.clone()).or_default() += amount;
                }
                // Track per-phase and HP-bucketed damage to enemies
                if !dest_guid.starts_with("Player-") && !dest_name.is_empty() {
                    *tracker.phase_damage_targets
                        .entry(tracker.current_phase).or_default()
                        .entry(dest_name.clone()).or_default() += amount;

                }
            }

            if dest_guid.starts_with("Player-") && amount > 0 {
                *tracker.damage_taken_by_player.entry(dest_guid.clone()).or_insert(0) += amount;
                let overkill: i64 = fields.get(30).and_then(|s| s.parse().ok()).unwrap_or(-1);
                tracker.last_damage_to.insert(dest_guid.clone(), ("Melee".to_string(), source_name.clone(), amount, overkill));
                // HP from advanced info: for SWING events, currentHP at [11], maxHP at [12]
                let current_hp: u64 = fields.get(11).and_then(|s| s.parse().ok()).unwrap_or(0);
                let max_hp: u64 = fields.get(12).and_then(|s| s.parse().ok()).unwrap_or(0);
                tracker.push_recap_event(&dest_guid, RecapEvent {
                    timestamp: timestamp_str.to_string(),
                    time_into_fight_secs: timestamp_secs - start_secs,
                    event_type: "damage".to_string(),
                    amount,
                    spell_name: "Melee".to_string(),
                    spell_id: 0,
                    source_name: source_name.clone(),
                    wowhead_url: String::new(),
                    current_hp,
                    max_hp,
                });
            }
        }
        "SPELL_HEAL" | "SPELL_PERIODIC_HEAL" | "SPELL_HEAL_SUPPORT" => {
            let spell_id: u64 = fields.get(9).and_then(|s| s.parse().ok()).unwrap_or(0);
            let spell_name = fields.get(10).map(|s| unquote(s)).unwrap_or_default();
            let spell_school: u32 = fields.get(11).and_then(|s| parse_hex_or_dec(s)).unwrap_or(0);
            let effective_amount = find_heal_amount(fields, 31);
            let raw_amount = find_damage_amount(fields, 31); // raw heal amount before overhealing

            if source_guid.starts_with("Player-") && effective_amount > 0 {
                let entry = tracker.healing_by_player
                    .entry(source_guid.clone())
                    .or_default()
                    .entry(spell_id)
                    .or_insert_with(|| (spell_name.clone(), spell_school, 0, 0));
                entry.2 += effective_amount;
                entry.3 += 1;
                // Track per-target
                *tracker.healing_targets
                    .entry(source_guid.clone()).or_default()
                    .entry(spell_id).or_default()
                    .entry(dest_name.clone()).or_default() += effective_amount;
            }

            // Track healing received on the target for death recap (use raw amount so heals always show)
            if dest_guid.starts_with("Player-") && raw_amount > 0 {
                // HP from advanced info: for SPELL events, currentHP at [14], maxHP at [15]
                let current_hp: u64 = fields.get(14).and_then(|s| s.parse().ok()).unwrap_or(0);
                let max_hp: u64 = fields.get(15).and_then(|s| s.parse().ok()).unwrap_or(0);
                tracker.push_recap_event(&dest_guid, RecapEvent {
                    timestamp: timestamp_str.to_string(),
                    time_into_fight_secs: timestamp_secs - start_secs,
                    event_type: "healing".to_string(),
                    amount: raw_amount,
                    spell_name,
                    spell_id,
                    source_name: source_name.clone(),
                    wowhead_url: wowhead_url(spell_id),
                    current_hp,
                    max_hp,
                });
            }
        }
        "SPELL_AURA_APPLIED" | "SPELL_AURA_REFRESH" => {
            if dest_guid.starts_with("Player-") {
                let spell_id: u64 = fields.get(9).and_then(|s| s.parse().ok()).unwrap_or(0);
                let spell_name = fields.get(10).map(|s| unquote(s)).unwrap_or_default();
                if spell_id > 0 {
                    tracker.aura_spell_names.insert(spell_id, spell_name.clone());
                    tracker.aura_sources.insert((dest_guid.clone(), spell_id), source_name.clone());
                    let stacks = tracker.active_aura_stacks
                        .entry(dest_guid.clone()).or_default()
                        .entry(spell_id).or_insert(0);
                    *stacks = 1;
                    tracker.raw_aura_events
                        .entry(dest_guid.clone()).or_default()
                        .entry(spell_id).or_default()
                        .push((timestamp_secs - start_secs, "apply".to_string(), 1));
                }
                // Death recap
                tracker.push_recap_event(&dest_guid, RecapEvent {
                    timestamp: timestamp_str.to_string(),
                    time_into_fight_secs: timestamp_secs - start_secs,
                    event_type: "buff_applied".to_string(),
                    amount: 0,
                    spell_name,
                    spell_id,
                    source_name: source_name.clone(),
                    wowhead_url: wowhead_url(spell_id),
                    current_hp: 0,
                    max_hp: 0,
                });
            }
        }
        "SPELL_AURA_REMOVED" => {
            if dest_guid.starts_with("Player-") {
                let spell_id: u64 = fields.get(9).and_then(|s| s.parse().ok()).unwrap_or(0);
                let spell_name = fields.get(10).map(|s| unquote(s)).unwrap_or_default();
                if spell_id > 0 {
                    tracker.aura_spell_names.insert(spell_id, spell_name.clone());
                    if let Some(stacks) = tracker.active_aura_stacks
                        .entry(dest_guid.clone()).or_default()
                        .get_mut(&spell_id)
                    {
                        *stacks = 0;
                    }
                    tracker.raw_aura_events
                        .entry(dest_guid.clone()).or_default()
                        .entry(spell_id).or_default()
                        .push((timestamp_secs - start_secs, "remove".to_string(), 0));
                }
                // Death recap
                tracker.push_recap_event(&dest_guid, RecapEvent {
                    timestamp: timestamp_str.to_string(),
                    time_into_fight_secs: timestamp_secs - start_secs,
                    event_type: "buff_removed".to_string(),
                    amount: 0,
                    spell_name,
                    spell_id,
                    source_name: source_name.clone(),
                    wowhead_url: wowhead_url(spell_id),
                    current_hp: 0,
                    max_hp: 0,
                });
            }
        }
        "SPELL_AURA_APPLIED_DOSE" => {
            if dest_guid.starts_with("Player-") {
                let spell_id: u64 = fields.get(9).and_then(|s| s.parse().ok()).unwrap_or(0);
                // Stack count is in field 15 for aura dose events
                let new_stacks: u32 = fields.get(15).and_then(|s| s.parse().ok()).unwrap_or(0);
                if spell_id > 0 && new_stacks > 0 {
                    *tracker.active_aura_stacks
                        .entry(dest_guid.clone()).or_default()
                        .entry(spell_id).or_insert(0) = new_stacks;
                    tracker.raw_aura_events
                        .entry(dest_guid.clone()).or_default()
                        .entry(spell_id).or_default()
                        .push((timestamp_secs - start_secs, "stack".to_string(), new_stacks));
                }
            }
        }
        "SPELL_AURA_REMOVED_DOSE" => {
            if dest_guid.starts_with("Player-") {
                let spell_id: u64 = fields.get(9).and_then(|s| s.parse().ok()).unwrap_or(0);
                let new_stacks: u32 = fields.get(15).and_then(|s| s.parse().ok()).unwrap_or(0);
                if spell_id > 0 {
                    *tracker.active_aura_stacks
                        .entry(dest_guid.clone()).or_default()
                        .entry(spell_id).or_insert(0) = new_stacks;
                    tracker.raw_aura_events
                        .entry(dest_guid.clone()).or_default()
                        .entry(spell_id).or_default()
                        .push((timestamp_secs - start_secs, "stack".to_string(), new_stacks));
                }
            }
        }
        "UNIT_DIED" => {
            if dest_guid.starts_with("Player-") {
                let (killing_spell, killing_source, killing_amount, overkill_raw) = tracker.last_damage_to
                    .get(&dest_guid)
                    .cloned()
                    .unwrap_or(("Unknown".to_string(), "Unknown".to_string(), 0, -1));

                let time_into_fight = timestamp_secs - start_secs;
                let recap = tracker.take_recap(&dest_guid, time_into_fight);

                let overkill = if overkill_raw > 0 { Some(overkill_raw) } else { None };

                tracker.death_events.push(DeathEvent {
                    timestamp: timestamp_str.to_string(),
                    player_name: dest_name.clone(),
                    player_guid: dest_guid.clone(),
                    killing_blow_spell: Some(killing_spell),
                    killing_blow_source: Some(killing_source),
                    killing_blow_amount: Some(killing_amount),
                    overkill,
                    time_into_fight_secs: time_into_fight,
                    recap,
                });

                *tracker.player_death_counts.entry(dest_guid).or_insert(0) += 1;
            } else {
                // Track creature kills
                *tracker.kill_counts.entry(dest_name.clone()).or_insert(0) += 1;
                // Detect creature type from GUID prefix
                let guid_type = if dest_guid.starts_with("Creature-") {
                    "Creature"
                } else if dest_guid.starts_with("Vehicle-") {
                    "Vehicle"
                } else if dest_guid.starts_with("Pet-") {
                    "Pet"
                } else {
                    "Other"
                };
                tracker.creature_types.entry(dest_name.clone()).or_insert_with(|| guid_type.to_string());
            }
        }
        _ => {}
    }
}

/// Try to find the damage amount from fields
fn find_damage_amount(fields: &[&str], expected_offset: usize) -> u64 {
    if let Some(val) = fields.get(expected_offset).and_then(|s| s.parse::<i64>().ok()) {
        if val >= 0 {
            return val as u64;
        }
    }
    for offset in &[expected_offset.wrapping_sub(1), expected_offset + 1, expected_offset.wrapping_sub(2), expected_offset + 2] {
        if let Some(val) = fields.get(*offset).and_then(|s| s.parse::<i64>().ok()) {
            if val > 0 && val < 100_000_000 {
                return val as u64;
            }
        }
    }
    0
}

/// Find healing amount — subtracts overhealing
/// WoW 12.0 heal suffix: amount, baseAmount, overhealing, absorbed, critical
fn find_heal_amount(fields: &[&str], expected_offset: usize) -> u64 {
    let amount = find_damage_amount(fields, expected_offset);
    // Overhealing is at offset+2 (was offset+1 before WoW 12.0 added baseAmount field)
    let overheal = fields.get(expected_offset + 2)
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(0);
    amount.saturating_sub(overheal)
}

/// Split a log line into timestamp and event parts
fn split_timestamp_event(line: &str) -> Option<(&str, &str)> {
    let pos = line.find("  ")?;
    Some((&line[..pos], &line[pos + 2..]))
}

/// Parse a timestamp string to seconds for duration calculation
fn parse_timestamp_to_secs(ts: &str) -> f64 {
    let parts: Vec<&str> = ts.splitn(2, ' ').collect();
    if parts.len() < 2 {
        return 0.0;
    }

    let date_parts: Vec<&str> = parts[0].split('/').collect();
    let time_parts: Vec<&str> = parts[1].split(':').collect();
    if time_parts.len() < 3 {
        return 0.0;
    }

    let day: f64 = date_parts.get(1).and_then(|s| s.parse().ok()).unwrap_or(0.0);
    let year_val: f64 = date_parts.get(2).and_then(|s| s.parse().ok()).unwrap_or(0.0);
    let month: f64 = date_parts.first().and_then(|s| s.parse().ok()).unwrap_or(0.0);
    let hour: f64 = time_parts[0].parse().unwrap_or(0.0);
    let minute: f64 = time_parts[1].parse().unwrap_or(0.0);

    let sec_parts: Vec<&str> = time_parts[2].split('.').collect();
    let second: f64 = sec_parts[0].parse().unwrap_or(0.0);
    let ms: f64 = sec_parts.get(1).and_then(|s| s.parse().ok()).unwrap_or(0.0) / 10000.0;

    ((year_val * 366.0 + month * 31.0 + day) * 86400.0) + hour * 3600.0 + minute * 60.0 + second + ms
}

/// Parse CSV fields, respecting quoted strings
fn parse_csv_fields(input: &str) -> Vec<&str> {
    let mut fields = Vec::new();
    let bytes = input.as_bytes();
    let len = bytes.len();
    let mut i = 0;

    while i < len {
        while i < len && bytes[i] == b' ' {
            i += 1;
        }
        if i >= len {
            break;
        }

        if bytes[i] == b'"' {
            let start = i;
            i += 1;
            while i < len && bytes[i] != b'"' {
                i += 1;
            }
            if i < len {
                i += 1;
            }
            fields.push(&input[start..i]);
            if i < len && bytes[i] == b',' {
                i += 1;
            }
        } else {
            let start = i;
            let mut depth = 0i32;
            while i < len {
                match bytes[i] {
                    b'(' | b'[' => depth += 1,
                    b')' | b']' => depth -= 1,
                    b',' if depth <= 0 => break,
                    _ => {}
                }
                i += 1;
            }
            fields.push(&input[start..i]);
            if i < len && bytes[i] == b',' {
                i += 1;
            }
        }
    }

    fields
}

/// Remove quotes from a string
fn unquote(s: &str) -> String {
    s.trim_matches('"').to_string()
}

/// Parse a hex (0xNN) or decimal number to u32
fn parse_hex_or_dec(s: &str) -> Option<u32> {
    if s.starts_with("0x") || s.starts_with("0X") {
        u32::from_str_radix(&s[2..], 16).ok()
    } else {
        s.parse().ok()
    }
}

/// Map WoW specialization ID to (class_name, spec_name, role)
fn spec_info(spec_id: u32) -> Option<(&'static str, &'static str, &'static str)> {
    match spec_id {
        // Warrior
        71 => Some(("Warrior", "Arms", "dps")),
        72 => Some(("Warrior", "Fury", "dps")),
        73 => Some(("Warrior", "Protection", "tank")),
        // Paladin
        65 => Some(("Paladin", "Holy", "healer")),
        66 => Some(("Paladin", "Protection", "tank")),
        70 => Some(("Paladin", "Retribution", "dps")),
        // Hunter
        253 => Some(("Hunter", "Beast Mastery", "dps")),
        254 => Some(("Hunter", "Marksmanship", "dps")),
        255 => Some(("Hunter", "Survival", "dps")),
        // Rogue
        259 => Some(("Rogue", "Assassination", "dps")),
        260 => Some(("Rogue", "Outlaw", "dps")),
        261 => Some(("Rogue", "Subtlety", "dps")),
        // Priest
        256 => Some(("Priest", "Discipline", "healer")),
        257 => Some(("Priest", "Holy", "healer")),
        258 => Some(("Priest", "Shadow", "dps")),
        // Death Knight
        250 => Some(("Death Knight", "Blood", "tank")),
        251 => Some(("Death Knight", "Frost", "dps")),
        252 => Some(("Death Knight", "Unholy", "dps")),
        // Shaman
        262 => Some(("Shaman", "Elemental", "dps")),
        263 => Some(("Shaman", "Enhancement", "dps")),
        264 => Some(("Shaman", "Restoration", "healer")),
        // Mage
        62 => Some(("Mage", "Arcane", "dps")),
        63 => Some(("Mage", "Fire", "dps")),
        64 => Some(("Mage", "Frost", "dps")),
        // Warlock
        265 => Some(("Warlock", "Affliction", "dps")),
        266 => Some(("Warlock", "Demonology", "dps")),
        267 => Some(("Warlock", "Destruction", "dps")),
        // Monk
        268 => Some(("Monk", "Brewmaster", "tank")),
        270 => Some(("Monk", "Mistweaver", "healer")),
        269 => Some(("Monk", "Windwalker", "dps")),
        // Druid
        102 => Some(("Druid", "Balance", "dps")),
        103 => Some(("Druid", "Feral", "dps")),
        104 => Some(("Druid", "Guardian", "tank")),
        105 => Some(("Druid", "Restoration", "healer")),
        // Demon Hunter
        577 => Some(("Demon Hunter", "Havoc", "dps")),
        581 => Some(("Demon Hunter", "Vengeance", "tank")),
        // Evoker
        1467 => Some(("Evoker", "Devastation", "dps")),
        1468 => Some(("Evoker", "Preservation", "healer")),
        1473 => Some(("Evoker", "Augmentation", "dps")),
        _ => None,
    }
}
