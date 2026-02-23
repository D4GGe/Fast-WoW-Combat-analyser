import { useEffect, useState } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import { fetchSummary } from '../api'
import type { CombatLogSummary, EncounterSummary, ZoneChange } from '../types'
import { formatDuration, formatNumber } from '../utils'

export default function EncounterList() {
    const { filename } = useParams<{ filename: string }>()
    const navigate = useNavigate()
    const [summary, setSummary] = useState<CombatLogSummary | null>(null)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const [modalPulls, setModalPulls] = useState<{ name: string; pulls: EncounterSummary[] } | null>(null)

    useEffect(() => {
        if (!filename) return
        fetchSummary(filename)
            .then(({ summary }) => { setSummary(summary); setLoading(false) })
            .catch(e => { setError(e.message); setLoading(false) })
    }, [filename])

    if (loading) {
        return (
            <div className="loading">
                <div className="spinner" />
                <div className="loading-text">Parsing combat log...</div>
                <div className="loading-sub">This may take a moment for large files</div>
            </div>
        )
    }

    if (error) return <div className="empty-state"><div className="icon">❌</div><div className="title">Error</div><p>{error}</p></div>
    if (!summary) return null

    const encounters = summary.encounters
    if (encounters.length === 0) {
        return (
            <>
                <Link to="/" className="back-btn">← Back to logs</Link>
                <div className="empty-state"><div className="icon">🔍</div><div className="title">No encounters found</div><p>This log file doesn't contain any encounters.</p></div>
            </>
        )
    }

    const bossEncs = encounters.filter(e => e.encounter_type !== 'trash')
    const kills = bossEncs.filter(e => e.success).length
    const wipes = bossEncs.filter(e => !e.success).length
    const zones = [...new Set(summary.zone_changes.map(z => z.zone_name))]

    // Split M+ and raid encounters
    const mplusEncs = encounters.filter(e => e.encounter_type === 'mythic_plus')
    const raidEncs = encounters.filter(e => e.encounter_type !== 'mythic_plus')

    // Zone resolution
    const zc = (summary.zone_changes || []).slice().sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
    function zoneFor(enc: EncounterSummary) {
        let zone = ''
        const t = new Date(enc.start_time)
        for (const z of zc) { if (new Date(z.timestamp) <= t) zone = z.zone_name; else break }
        return zone
    }

    // Group raid encounters into sessions
    interface Session { encounters: EncounterSummary[] }
    const sessions: Session[] = []
    if (raidEncs.length > 0) {
        let cur: EncounterSummary[] = [raidEncs[0]]
        for (let i = 1; i < raidEncs.length; i++) {
            const prev = raidEncs[i - 1], c = raidEncs[i]
            const gapMin = (new Date(c.start_time).getTime() - new Date(prev.end_time || prev.start_time).getTime()) / 60000
            if (gapMin > 30 || c.difficulty_id !== prev.difficulty_id || zoneFor(c) !== zoneFor(prev)) {
                sessions.push({ encounters: cur }); cur = [c]
            } else { cur.push(c) }
        }
        sessions.push({ encounters: cur })
    }

    function goToEncounter(enc: EncounterSummary) {
        navigate(`/log/${encodeURIComponent(filename!)}/encounter/${enc.index}`)
    }

    return (
        <>
            <Link to="/" className="back-btn">← Back to logs</Link>
            <h1 className="page-title">{zones.join(', ') || filename}</h1>
            <p className="page-subtitle">{bossEncs.length} encounters — {kills} kills, {wipes} wipes</p>

            <div className="stats-grid">
                <div className="stat-card"><div className="stat-value">{bossEncs.length}</div><div className="stat-label">Encounters</div></div>
                <div className="stat-card"><div className="stat-value" style={{ color: 'var(--accent-green)' }}>{kills}</div><div className="stat-label">Kills</div></div>
                <div className="stat-card"><div className="stat-value" style={{ color: 'var(--accent-red)' }}>{wipes}</div><div className="stat-label">Wipes</div></div>
                <div className="stat-card"><div className="stat-value">{zones.length}</div><div className="stat-label">Zones</div></div>
            </div>

            <div className="card-grid">
                {/* M+ Keys */}
                {mplusEncs.map((enc, i) => (
                    <div key={enc.index} className="card encounter-card animate-in" style={{ animationDelay: `${i * 30}ms` }} onClick={() => goToEncounter(enc)}>
                        <div className="card-header">
                            <div className="card-title">🗝️ {enc.name}</div>
                            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                                {enc.key_level && <span className="key-badge">+{enc.key_level}</span>}
                                <span className={`encounter-result ${enc.success ? 'kill' : 'wipe'}`}>
                                    {enc.success ? '✓ Timed' : '✗ Depleted'}
                                </span>
                            </div>
                        </div>
                        <div className="card-meta">
                            <span>⏱ {formatDuration(enc.duration_secs)}</span>
                            <span>⚔️ {enc.difficulty_name}</span>
                            <span>👥 {enc.group_size} players</span>
                            {enc.deaths.length > 0 && <span>💀 {enc.deaths.length} deaths</span>}
                        </div>
                        {enc.boss_encounters.length > 0 && (
                            <div className="boss-list">
                                {enc.boss_encounters.map((b, bi) => (
                                    <span key={bi} className={`boss-chip ${b.success ? 'killed' : 'wiped'}`}>
                                        {b.success ? '✓' : '✗'} {b.name}
                                    </span>
                                ))}
                            </div>
                        )}
                    </div>
                ))}

                {/* Raid sessions */}
                {sessions.map((session, si) => {
                    const s = session.encounters
                    const sKills = s.filter(e => e.success && e.encounter_type !== 'trash').length
                    const sWipes = s.filter(e => !e.success && e.encounter_type !== 'trash').length
                    const sessionZone = zoneFor(s[0])
                    const sessionDiff = s[0].difficulty_name
                    const startD = new Date(s[0].start_time)
                    const endD = new Date(s[s.length - 1].end_time || s[s.length - 1].start_time)
                    const timeFmt = (d: Date) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                    const dateFmt = (d: Date) => d.toLocaleDateString([], { month: 'short', day: 'numeric' })

                    // Build render order: group boss pulls under boss names, consolidate consecutive trash
                    type RenderItem = { type: 'trash'; encounters: EncounterSummary[] } | { type: 'boss'; name: string; pulls: EncounterSummary[] }
                    const renderOrder: RenderItem[] = []
                    const bossMap: Record<string, EncounterSummary[]> = {}

                    s.forEach(enc => {
                        if (enc.encounter_type === 'trash') {
                            // Merge into the previous trash group if possible
                            const last = renderOrder[renderOrder.length - 1]
                            if (last && last.type === 'trash') {
                                last.encounters.push(enc)
                            } else {
                                renderOrder.push({ type: 'trash', encounters: [enc] })
                            }
                        } else {
                            if (!bossMap[enc.name]) {
                                bossMap[enc.name] = []
                                renderOrder.push({ type: 'boss', name: enc.name, pulls: bossMap[enc.name] })
                            }
                            bossMap[enc.name].push(enc)
                        }
                    })

                    return (
                        <div key={si} style={{ gridColumn: '1 / -1', display: 'contents' }}>
                            {/* Session header */}
                            <div style={{ gridColumn: '1 / -1', margin: si > 0 ? '24px 0 8px 0' : '0 0 8px 0' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
                                    <div style={{ height: 1, flex: 1, background: 'var(--border-color)' }} />
                                    <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--accent-gold)', textTransform: 'uppercase', letterSpacing: 1, whiteSpace: 'nowrap' }}>
                                        {sessionZone || 'Raid'}{sessionDiff ? ` — ${sessionDiff}` : ''}
                                    </div>
                                    <div style={{ height: 1, flex: 1, background: 'var(--border-color)' }} />
                                </div>
                                <div style={{ display: 'flex', justifyContent: 'center', gap: 20, fontSize: 13, color: 'var(--text-secondary)', marginBottom: 12 }}>
                                    <span>📅 {dateFmt(startD)}</span>
                                    <span>🟢 Start {timeFmt(startD)}</span>
                                    <span>🔴 End {timeFmt(endD)}</span>
                                    <span style={{ color: 'var(--accent-green)' }}>✓ {sKills} kills</span>
                                    <span style={{ color: 'var(--accent-red)' }}>✗ {sWipes} wipes</span>
                                </div>
                            </div>

                            {/* Encounter items */}
                            {renderOrder.map((item, bi) => {
                                if (item.type === 'trash') return null
                                // Boss group — card style like M+
                                const pulls = item.pulls
                                const killCount = pulls.filter(p => p.success).length
                                const wipeCount = pulls.filter(p => !p.success).length
                                const bestTime = Math.min(...pulls.filter(p => p.duration_secs > 0).map(p => p.duration_secs))
                                const totalDeaths = pulls.reduce((s, p) => s + p.deaths.length, 0)
                                const diff = pulls[0].difficulty_name
                                const groupSize = pulls[0].group_size
                                // Find the last kill, or the last pull if all wipes
                                const lastKill = pulls.slice().reverse().find(p => p.success) || pulls[pulls.length - 1]
                                return (
                                    <div key={`boss-${item.name}`} className="card animate-in" style={{ animationDelay: `${bi * 30}ms`, cursor: 'pointer' }}
                                        onClick={() => goToEncounter(lastKill)}
                                    >
                                        <div className="card-header">
                                            <div className="card-title">⚔️ {item.name}</div>
                                            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                                                {killCount > 0 && <span className="encounter-result kill">✓ Kill</span>}
                                                {wipeCount > 0 && <span className="encounter-result wipe">✗ {wipeCount} {wipeCount === 1 ? 'Wipe' : 'Wipes'}</span>}
                                            </div>
                                        </div>
                                        <div className="card-meta">
                                            <span>⚔️ {diff}</span>
                                            <span>👥 {groupSize} players</span>
                                            <span>{pulls.length} {pulls.length === 1 ? 'pull' : 'pulls'}</span>
                                            {bestTime < Infinity && <span>⏱ Best: {formatDuration(bestTime)}</span>}
                                            {totalDeaths > 0 && <span>💀 {totalDeaths} deaths</span>}
                                        </div>
                                        {pulls.length > 1 && (
                                            <div style={{ marginTop: 10 }}>
                                                <button
                                                    onClick={e => { e.stopPropagation(); setModalPulls({ name: item.name!, pulls }) }}
                                                    style={{ padding: '5px 14px', fontSize: 12, fontWeight: 600, background: 'rgba(139,92,246,0.12)', border: '1px solid var(--accent-purple)', color: 'var(--accent-purple)', borderRadius: 7, cursor: 'pointer', transition: 'all 0.15s' }}
                                                    onMouseOver={e => { (e.currentTarget).style.background = 'rgba(139,92,246,0.25)' }}
                                                    onMouseOut={e => { (e.currentTarget).style.background = 'rgba(139,92,246,0.12)' }}
                                                >
                                                    📋 Show Pulls ({pulls.length})
                                                </button>
                                            </div>
                                        )}
                                    </div>
                                )
                            })}
                        </div>
                    )
                })}
            </div>
            {/* Pulls modal */}
            {modalPulls && (
                <div
                    onClick={() => setModalPulls(null)}
                    style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(6px)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                >
                    <div
                        onClick={e => e.stopPropagation()}
                        style={{ background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 14, padding: '24px 28px', minWidth: 380, maxWidth: 500, maxHeight: '80vh', overflowY: 'auto', boxShadow: '0 16px 64px rgba(0,0,0,0.5)' }}
                    >
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                            <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-primary)' }}>⚔️ {modalPulls.name}</div>
                            <button
                                onClick={() => setModalPulls(null)}
                                style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: 20, cursor: 'pointer', padding: '4px 8px', lineHeight: 1 }}
                            >✕</button>
                        </div>
                        <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 14 }}>
                            {modalPulls.pulls.length} pulls — {modalPulls.pulls.filter(p => p.success).length} kills, {modalPulls.pulls.filter(p => !p.success).length} wipes
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                            {modalPulls.pulls.map((p, pi) => (
                                <div
                                    key={p.index}
                                    onClick={() => { setModalPulls(null); goToEncounter(p) }}
                                    style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', background: 'var(--bg-secondary)', borderRadius: 8, cursor: 'pointer', border: '1px solid var(--border-color)', transition: 'all 0.15s' }}
                                    onMouseOver={e => { e.currentTarget.style.background = 'var(--bg-card-hover)'; e.currentTarget.style.borderColor = 'var(--border-glow)' }}
                                    onMouseOut={e => { e.currentTarget.style.background = 'var(--bg-secondary)'; e.currentTarget.style.borderColor = 'var(--border-color)' }}
                                >
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                                        <span style={{ color: 'var(--text-muted)', fontSize: 12, fontWeight: 600, minWidth: 50 }}>Pull {pi + 1}</span>
                                        <span style={{ fontSize: 14, fontWeight: 500 }}>{formatDuration(p.duration_secs)}</span>
                                        {p.deaths.length > 0 && <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>💀 {p.deaths.length}</span>}
                                    </div>
                                    <span className={`encounter-result ${p.success ? 'kill' : 'wipe'}`} style={{ fontSize: 11, padding: '2px 10px' }}>
                                        {p.success ? '✓ Kill' : '✗ Wipe'}
                                    </span>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
            )}
        </>
    )
}
