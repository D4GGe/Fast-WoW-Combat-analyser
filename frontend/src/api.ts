import type { LogFileInfo, CombatLogSummary } from './types';

const API_BASE = '';

export async function fetchLogs(): Promise<LogFileInfo[]> {
    const res = await fetch(`${API_BASE}/api/logs`);
    if (!res.ok) throw new Error(await res.text());
    return res.json();
}

export interface SummaryResponse {
    summary: CombatLogSummary;
    cacheStatus: string;
    parseTime: string;
}

export async function fetchSummary(filename: string, noCache = false): Promise<SummaryResponse> {
    const opts: RequestInit = noCache ? { cache: 'no-store' } : {};
    const res = await fetch(`${API_BASE}/api/logs/${encodeURIComponent(filename)}/summary`, opts);
    if (!res.ok) throw new Error(await res.text());
    const cacheStatus = res.headers.get('X-Cache-Status') || 'UNKNOWN';
    const parseTime = res.headers.get('X-Parse-Time') || '0';
    const summary = await res.json();
    return { summary, cacheStatus, parseTime };
}

export async function fetchSpellTooltips(): Promise<Record<string, { name?: string; icon_url?: string; description?: string }>> {
    try {
        const res = await fetch(`${API_BASE}/api/spell_tooltips`);
        if (!res.ok) return {};
        return await res.json();
    } catch {
        return {};
    }
}

export async function fetchReplayData(filename: string, index: number): Promise<import('./types').ReplayData> {
    const res = await fetch(`${API_BASE}/api/logs/${encodeURIComponent(filename)}/encounter/${index}/replay`);
    if (!res.ok) throw new Error(await res.text());
    return res.json();
}
