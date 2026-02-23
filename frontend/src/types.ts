// TypeScript interfaces matching the Rust models in models.rs

export interface LogFileInfo {
    filename: string;
    size_bytes: number;
    size_display: string;
    date_str: string;
}

export interface CombatLogSummary {
    filename: string;
    log_version: number | null;
    build_version: string | null;
    encounters: EncounterSummary[];
    zone_changes: ZoneChange[];
}

export interface EncounterSummary {
    index: number;
    encounter_id: number;
    name: string;
    difficulty_id: number;
    difficulty_name: string;
    group_size: number;
    success: boolean;
    duration_secs: number;
    start_time: string;
    end_time: string;
    key_level: number | null;
    affixes: number[];
    encounter_type: string; // "boss", "mythic_plus", "trash"
    boss_encounters: BossEncounter[];
    players: PlayerSummary[];
    deaths: DeathEvent[];
    segments: KeySegment[];
    buff_uptimes: Record<string, BuffUptime[]>;
    enemy_breakdowns: EnemyBreakdown[];
    boss_hp_pct: number | null;
    boss_max_hp: number | null;
    phases: PhaseBreakdown[];
    time_bucketed_player_damage: Record<number, Record<string, number>>;
    boss_hp_timeline: [number, number][];
    replay_timeline: HpSnapshot[];
    boss_positions: [number, number, number][];
    raw_ability_events: [number, string, number, string, number, number, string][];
}

export interface BossEncounter {
    name: string;
    encounter_id: number;
    success: boolean;
    duration_secs: number;
    start_time: string;
    end_time: string;
}

export interface PhaseBreakdown {
    phase_id: number;
    start_time_secs: number;
    end_time_secs: number;
    enemy_breakdowns: EnemyBreakdown[];
}

export interface KeySegment {
    segment_type: string; // "trash" or "boss"
    name: string;
    index: number;
    duration_secs: number;
    start_time: string;
    end_time: string;
    players: PlayerSummary[];
    deaths: DeathEvent[];
    buff_uptimes: Record<string, BuffUptime[]>;
    enemy_breakdowns: EnemyBreakdown[];
    pulls: TrashPull[];
}

export interface TrashPull {
    pull_index: number;
    duration_secs: number;
    start_time_offset: number;
    enemies: PullEnemy[];
    players: PlayerSummary[];
    deaths: DeathEvent[];
}

export interface PullEnemy {
    name: string;
    damage_taken: number;
    mob_type: string;
}

export interface PlayerSummary {
    guid: string;
    name: string;
    class_name: string;
    spec_name: string;
    role: string;
    damage_done: number;
    healing_done: number;
    damage_taken: number;
    deaths: number;
    dps: number;
    hps: number;
    abilities: AbilityBreakdown[];
    heal_abilities: AbilityBreakdown[];
    damage_taken_abilities: AbilityBreakdown[];
}

export interface AbilityBreakdown {
    spell_id: number;
    spell_name: string;
    spell_school: number;
    total_amount: number;
    hit_count: number;
    wowhead_url: string;
    targets: TargetBreakdown[];
}

export interface TargetBreakdown {
    target_name: string;
    amount: number;
}

export interface EnemyBreakdown {
    target_name: string;
    total_damage: number;
    kill_count: number;
    mob_type: string;
    players: EnemyPlayerDamage[];
}

export interface EnemyPlayerDamage {
    player_name: string;
    class_name: string;
    damage: number;
}

export interface BuffUptime {
    spell_id: number;
    spell_name: string;
    source_name: string;
    uptime_secs: number;
    uptime_pct: number;
    avg_stacks: number;
    max_stacks: number;
    wowhead_url: string;
    timeline: BuffEvent[];
}

export interface BuffEvent {
    time: number;
    event_type: string; // "apply", "remove", "stack"
    stacks: number;
}

export interface DeathEvent {
    timestamp: string;
    player_name: string;
    player_guid: string;
    killing_blow_spell: string | null;
    killing_blow_source: string | null;
    killing_blow_amount: number | null;
    overkill: number | null;
    time_into_fight_secs: number;
    recap: RecapEvent[];
}

export interface RecapEvent {
    timestamp: string;
    time_into_fight_secs: number;
    event_type: string;
    amount: number;
    spell_name: string;
    spell_id: number;
    source_name: string;
    wowhead_url: string;
    current_hp: number;
    max_hp: number;
}

export interface HpSnapshot {
    time: number;
    guid: string;
    name: string;
    class_name: string;
    current_hp: number;
    max_hp: number;
    is_dead: boolean;
    pos_x: number | null;
    pos_y: number | null;
}

export interface ZoneChange {
    timestamp: string;
    zone_id: number;
    zone_name: string;
    difficulty_id: number;
}

export interface SpellTooltip {
    name?: string;
    icon_url?: string;
    description?: string;
}
