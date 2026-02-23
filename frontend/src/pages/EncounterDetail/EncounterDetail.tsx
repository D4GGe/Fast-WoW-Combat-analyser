import { useEffect, useState, useRef, useCallback, useMemo } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import { fetchSummary } from '../../api'
import type { CombatLogSummary, EncounterSummary, PlayerSummary, AbilityBreakdown, KeySegment, TrashPull } from '../../types'
import { formatDuration, formatNumber, classColor, roleIcon, getSchoolColor } from '../../utils'
import { spellHtml } from '../../components/SpellTooltip'
import { useSpellTooltips } from '../../hooks/useSpellTooltips'

type TabId = 'damage' | 'healing' | 'taken' | 'deaths' | 'abilities' | 'enemies' | 'buffs' | 'replay'

const TABS: { id: TabId; icon: string; label: string; always?: boolean }[] = [
    { id: 'damage', icon: '⚔️', label: 'Damage Done', always: true },
    { id: 'healing', icon: '💚', label: 'Healing Done', always: true },
    { id: 'taken', icon: '🛡️', label: 'Damage Taken', always: true },
    { id: 'deaths', icon: '💀', label: 'Deaths', always: true },
    { id: 'abilities', icon: '📊', label: 'Abilities', always: true },
    { id: 'enemies', icon: '👹', label: 'Enemies', always: true },
    { id: 'buffs', icon: '🔮', label: 'Buff Uptime', always: true },
    { id: 'replay', icon: '🎬', label: 'Replay' },
]

// ========== Segment/Pull filtering ==========
function getFilteredEncData(
    enc: EncounterSummary,
    selectedSegments: Set<number> | null,
    selectedPulls: Set<number> | null
): EncounterSummary {
    // Collect all relevant player data sources
    const playerSources: PlayerSummary[][] = []
    const deathSources: any[][] = []
    const buffSources: Record<string, any[]>[] = []
    const enemySources: any[][] = []

    if (selectedPulls !== null) {
        // Pull-level filtering: collect data from matching pulls across all segments
        for (const seg of enc.segments) {
            if (!seg.pulls) continue
            for (const pull of seg.pulls) {
                if (selectedPulls.has(pull.pull_index)) {
                    playerSources.push(pull.players)
                    deathSources.push(pull.deaths)
                }
            }
        }
    } else if (selectedSegments !== null) {
        // Segment-level filtering
        for (const seg of enc.segments) {
            if (selectedSegments.has(seg.index)) {
                playerSources.push(seg.players)
                deathSources.push(seg.deaths)
                if (seg.buff_uptimes) buffSources.push(seg.buff_uptimes)
                if (seg.enemy_breakdowns) enemySources.push(seg.enemy_breakdowns)
            }
        }
    }

    // Merge players by GUID
    const playerMap = new Map<string, PlayerSummary>()
    for (const players of playerSources) {
        for (const p of players) {
            const existing = playerMap.get(p.guid)
            if (!existing) {
                playerMap.set(p.guid, { ...p, abilities: [...p.abilities], heal_abilities: [...p.heal_abilities], damage_taken_abilities: [...p.damage_taken_abilities] })
            } else {
                existing.damage_done += p.damage_done
                existing.healing_done += p.healing_done
                existing.damage_taken += p.damage_taken
                existing.deaths += p.deaths
                // Merge abilities
                mergeAbilities(existing.abilities, p.abilities)
                mergeAbilities(existing.heal_abilities, p.heal_abilities)
                mergeAbilities(existing.damage_taken_abilities, p.damage_taken_abilities)
            }
        }
    }
    // Recalculate DPS/HPS based on filtered duration
    let filteredDuration = 0
    if (selectedPulls !== null) {
        for (const seg of enc.segments) {
            if (!seg.pulls) continue
            for (const pull of seg.pulls) {
                if (selectedPulls.has(pull.pull_index)) filteredDuration += pull.duration_secs
            }
        }
    } else if (selectedSegments !== null) {
        for (const seg of enc.segments) {
            if (selectedSegments.has(seg.index)) filteredDuration += seg.duration_secs
        }
    }
    if (filteredDuration <= 0) filteredDuration = 1
    for (const p of playerMap.values()) {
        p.dps = Math.round(p.damage_done / filteredDuration)
        p.hps = Math.round(p.healing_done / filteredDuration)
    }

    const mergedPlayers = Array.from(playerMap.values()).sort((a, b) => b.damage_done - a.damage_done)
    const mergedDeaths = deathSources.flat()

    // Merge buff uptimes
    const mergedBuffs: Record<string, any[]> = {}
    for (const bu of buffSources) {
        for (const [player, uptimes] of Object.entries(bu)) {
            if (!mergedBuffs[player]) mergedBuffs[player] = []
            mergedBuffs[player].push(...uptimes)
        }
    }

    const mergedEnemies = enemySources.flat()

    return {
        ...enc,
        players: mergedPlayers,
        deaths: mergedDeaths,
        buff_uptimes: Object.keys(mergedBuffs).length > 0 ? mergedBuffs : enc.buff_uptimes,
        enemy_breakdowns: mergedEnemies.length > 0 ? mergedEnemies : enc.enemy_breakdowns,
        duration_secs: filteredDuration,
    }
}

function mergeAbilities(target: AbilityBreakdown[], source: AbilityBreakdown[]) {
    for (const sa of source) {
        const existing = target.find(a => a.spell_id === sa.spell_id)
        if (existing) {
            existing.total_amount += sa.total_amount
            existing.hit_count += sa.hit_count
        } else {
            target.push({ ...sa })
        }
    }
}

export default function EncounterDetail() {
    const { filename, index } = useParams<{ filename: string; index: string }>()
    const navigate = useNavigate()
    const [summary, setSummary] = useState<CombatLogSummary | null>(null)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const [activeTab, setActiveTab] = useState<TabId>('damage')
    const [selectedSegments, setSelectedSegments] = useState<Set<number> | null>(null) // null = all
    const [selectedPulls, setSelectedPulls] = useState<Set<number> | null>(null) // null = all
    const contentRef = useRef<HTMLDivElement>(null)
    const { getTooltip } = useSpellTooltips()

    const encIndex = Number(index)

    useEffect(() => {
        if (!filename) return
        fetchSummary(filename)
            .then(({ summary }) => { setSummary(summary); setLoading(false) })
            .catch(e => { setError(e.message); setLoading(false) })
    }, [filename])

    const enc = summary?.encounters[encIndex] ?? null

    // Set encounter name for header breadcrumb (synchronous, before render)
    if (enc) {
        ; (window as any).__encName = enc.name
        document.title = `${enc.name} — Fast WoW Combat Analyzer`
        window.dispatchEvent(new Event('encNameChanged'))
    }

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            ; (window as any).__encName = null
            document.title = 'Fast WoW Combat Analyzer'
        }
    }, [])

    // Build filtered encounter data based on selected segments/pulls
    const filteredEnc = useMemo(() => {
        if (!enc) return null
        if (!enc.segments || enc.segments.length === 0) return enc
        if (selectedSegments === null && selectedPulls === null) return enc
        return getFilteredEncData(enc, selectedSegments, selectedPulls)
    }, [enc, selectedSegments, selectedPulls])

    // Inject tab content via innerHTML
    useEffect(() => {
        if (!enc || !contentRef.current) return
        const dataForTab = (activeTab === 'replay') ? enc : (filteredEnc || enc)
        const html = renderTab(activeTab, dataForTab, getTooltip)
        contentRef.current.innerHTML = html

        // Post-render: init canvas-based tabs
        if (activeTab === 'buffs') {
            const d = filteredEnc || enc
            const dur = d.duration_secs || 1
            const sel = document.getElementById('buff-player-select') as HTMLSelectElement | null
            const selGuid = sel?.value || d.players[0]?.guid
            if (selGuid) {
                const buffs = ((d.buff_uptimes || {})[selGuid] || []).sort((a: any, b: any) => b.uptime_pct - a.uptime_pct)
                setTimeout(() => drawBuffTimelines(buffs, dur), 0)
            }
        }
        if (activeTab === 'replay' && enc.replay_timeline?.length > 0) {
            // Clean up any previous replay before starting a new one
            if ((window as any).__replayCleanup) { (window as any).__replayCleanup(); (window as any).__replayCleanup = null }
            setTimeout(() => initReplayControls(enc), 0)
        }
        // Init timeline range slider for damage tab
        if (activeTab === 'damage' && enc.time_bucketed_player_damage && Object.keys(enc.time_bucketed_player_damage).length > 0 && enc.encounter_type === 'boss') {
            const encData = enc
            setTimeout(() => {
                const startEl = document.getElementById('timeline-start') as HTMLInputElement
                const endEl = document.getElementById('timeline-end') as HTMLInputElement
                const fillEl = document.getElementById('timeline-range-fill') as HTMLElement
                const labelEl = document.getElementById('timeline-range-label') as HTMLElement
                if (!startEl || !endEl || !fillEl || !labelEl) return
                const dur = Math.ceil(encData.duration_secs || 1)
                const fmtTime = (s: number) => { const m = Math.floor(s / 60); const sec = s % 60; return m + ':' + (sec < 10 ? '0' : '') + sec }
                function updateSlider() {
                    let s = parseInt(startEl.value), e = parseInt(endEl.value)
                    if (s > e) { if (document.activeElement === startEl) { endEl.value = String(s); e = s } else { startEl.value = String(e); s = e } }
                    const pctL = (s / dur * 100), pctR = ((dur - e) / dur * 100)
                    fillEl.style.left = pctL + '%'
                    fillEl.style.right = pctR + '%'
                    labelEl.textContent = fmtTime(s) + ' — ' + fmtTime(e)

                    // Recompute player damage from buckets for this time range
                    const buckets = encData.time_bucketed_player_damage as Record<string, Record<string, number>>
                    const filtDur = Math.max(e - s, 1)
                    const playerDmg: Record<string, number> = {}
                    for (let sec = s; sec < e; sec++) {
                        const bk = buckets[String(sec)]
                        if (bk) {
                            for (const [guid, amt] of Object.entries(bk)) {
                                playerDmg[guid] = (playerDmg[guid] || 0) + (amt as number)
                            }
                        }
                    }
                    // Build filtered abilities from raw_ability_events
                    const rawEvts = encData.raw_ability_events || []
                    const filteredAbilitiesByGuid: Record<string, AbilityBreakdown[]> = {}
                    for (const [ts, guid, spellId, spellName, spellSchool, amount, targetName] of rawEvts) {
                        if (ts < s || ts >= e) continue
                        if (!filteredAbilitiesByGuid[guid]) filteredAbilitiesByGuid[guid] = []
                        const abilities = filteredAbilitiesByGuid[guid]
                        let ab = abilities.find(a => a.spell_id === spellId)
                        if (!ab) {
                            ab = { spell_id: spellId, spell_name: spellName, spell_school: spellSchool, total_amount: 0, hit_count: 0, wowhead_url: `https://www.wowhead.com/spell=${spellId}`, targets: [] }
                            abilities.push(ab)
                        }
                        ab.total_amount += amount
                        ab.hit_count += 1
                        let tgt = ab.targets.find(t => t.target_name === targetName)
                        if (!tgt) { tgt = { target_name: targetName, amount: 0 }; ab.targets.push(tgt) }
                        tgt.amount += amount
                    }

                    // Re-render the damage table with filtered data
                    const filtPlayers = encData.players.map(p => ({
                        ...p,
                        damage_done: playerDmg[p.guid] || 0,
                        dps: (playerDmg[p.guid] || 0) / filtDur,
                        abilities: (filteredAbilitiesByGuid[p.guid] || []).sort((a, b) => b.total_amount - a.total_amount)
                    })).sort((a, b) => b.damage_done - a.damage_done)
                    const maxDmg = Math.max(...filtPlayers.map(p => p.damage_done), 1)
                    const table = document.querySelector('.data-table')
                    if (table) {
                        const tbody = table.querySelector('tbody')
                        if (tbody) {
                            tbody.innerHTML = filtPlayers.map((p, i) => {
                                const pid = `dmg-${p.guid.replace(/[^a-zA-Z0-9]/g, '')}`
                                const pct = (p.damage_done / maxDmg * 100).toFixed(1)
                                const cc = classColor(p.class_name)
                                const ri = roleIcon(p.role)
                                return `<tr class="player-row" style="cursor:pointer" data-toggle-detail="${pid}">
                                    <td class="rank ${i < 3 ? 'rank-' + (i + 1) : ''}">${i + 1}</td>
                                    <td><span title="${ri.label}" style="font-size:12px;margin-right:4px">${ri.icon}</span><strong style="color:${cc}">${p.name}</strong>${p.spec_name ? `<span style="color:${cc};opacity:0.6;font-size:11px;margin-left:6px">${p.spec_name} ${p.class_name}</span>` : ''}</td>
                                    <td class="num">${formatNumber(p.damage_done)}</td>
                                    <td class="bar-cell"><div class="bar-container"><div class="bar-fill" style="width:${pct}%;background:linear-gradient(90deg, var(--accent-purple), var(--accent-blue));opacity:0.8"></div><div class="bar-label">${formatNumber(p.damage_done)}</div></div></td>
                                    <td class="num" style="color:var(--accent-orange);font-weight:600">${formatNumber(Math.round(p.dps))}</td>
                                </tr>
                                <tr id="${pid}" class="detail-row" style="display:none">
                                    <td colspan="5" style="padding:0">
                                        <div style="display:flex;gap:8px;padding:8px 12px 0 12px">
                                            <button data-detail-pid="${pid}" data-detail-tab="abilities" style="padding:4px 12px;font-size:11px;font-weight:600;border:1px solid var(--accent-purple);background:rgba(139,92,246,0.13);color:var(--accent-purple);border-radius:6px;cursor:pointer">Abilities</button>
                                            <button data-detail-pid="${pid}" data-detail-tab="targets" style="padding:4px 12px;font-size:11px;font-weight:600;border:1px solid var(--border-color);background:transparent;color:var(--text-muted);border-radius:6px;cursor:pointer">Targets</button>
                                        </div>
                                        <div id="${pid}-abilities" class="ability-panel">${renderAbilityBreakdown(p.abilities || [], p.damage_done, getTooltip)}</div>
                                        <div id="${pid}-targets" class="ability-panel" style="display:none">${renderTargetBreakdown(p.abilities || [], p.damage_done, getTooltip)}</div>
                                    </td>
                                </tr>`
                            }).join('')
                        }
                    }
                }
                startEl.addEventListener('input', updateSlider)
                endEl.addEventListener('input', updateSlider)
            }, 0)
        }
    }, [activeTab, enc, filteredEnc, getTooltip])

    // Attach global event handlers for interactive elements
    useEffect(() => {
        function handleClick(e: Event) {
            const target = e.target as HTMLElement
            // Handle player detail toggle
            const row = target.closest('[data-toggle-detail]')
            if (row) {
                const id = row.getAttribute('data-toggle-detail')!
                const detailRow = document.getElementById(id)
                if (detailRow) {
                    detailRow.style.display = detailRow.style.display === 'none' ? '' : 'none'
                }
                return
            }
            // Handle detail tab switch
            const tabBtn = target.closest('[data-detail-tab]')
            if (tabBtn) {
                const pid = tabBtn.getAttribute('data-detail-pid')!
                const tab = tabBtn.getAttribute('data-detail-tab')!
                showDetailTab(pid, tab)
                return
            }
            // Handle death recap toggle
            const deathHeader = target.closest('[data-toggle-recap]')
            if (deathHeader) {
                const idx = deathHeader.getAttribute('data-toggle-recap')!
                const recap = document.getElementById(`recap-${idx}`)
                if (recap) recap.classList.toggle('visible')
                deathHeader.classList.toggle('expanded')
                return
            }
            // Handle enemy toggle
            const enemyToggle = target.closest('[data-toggle-enemy]')
            if (enemyToggle) {
                const idx = enemyToggle.getAttribute('data-toggle-enemy')!
                const details = document.getElementById(`enemy-${idx}`)
                if (details) details.style.display = details.style.display === 'none' ? '' : 'none'
                return
            }

            // Handle Self Only button
            if ((target as HTMLElement).id === 'buff-self-only' && enc) {
                const btn = target as HTMLElement
                const isActive = btn.getAttribute('data-active') === 'true'
                btn.setAttribute('data-active', isActive ? 'false' : 'true')
                btn.style.background = isActive ? 'var(--bg-card)' : 'rgba(6,182,212,0.15)'
                btn.style.borderColor = isActive ? 'var(--border-color)' : 'rgba(6,182,212,0.5)'
                btn.style.color = isActive ? 'var(--text-muted)' : 'var(--accent-cyan)'
                // Re-render buff list with filter
                const dataForTab = filteredEnc || enc
                const sel = document.getElementById('buff-player-select') as HTMLSelectElement | null
                const guid = sel?.value || dataForTab.players[0]?.guid
                const playerName = dataForTab.players.find(p => p.guid === guid)?.name || ''
                let buffs = ((dataForTab.buff_uptimes || {})[guid] || []).sort((a: any, b: any) => b.uptime_pct - a.uptime_pct)
                if (!isActive) {
                    buffs = buffs.filter((b: any) => b.source_name === playerName)
                }
                const dur = dataForTab.duration_secs || 1
                const listEl = document.getElementById('buff-list')
                if (listEl) {
                    listEl.innerHTML = renderBuffList(buffs, dur, getTooltip)
                    setTimeout(() => drawBuffTimelines(buffs, dur), 0)
                }
                return
            }
            // Navigate to encounter
            const encNav = target.closest('[data-enc-index]')
            if (encNav) {
                const navIdx = encNav.getAttribute('data-enc-index')!
                navigate(`/log/${encodeURIComponent(filename!)}/encounter/${navIdx}`)
                return
            }
        }
        // Handle select change for abilities and buff player
        function handleChange(e: Event) {
            const target = e.target as HTMLSelectElement
            if (target.id === 'ability-player-select' && enc) {
                const dataForTab = filteredEnc || enc
                const guid = target.value
                const player = dataForTab.players.find(p => p.guid === guid)
                const listEl = document.getElementById('ability-list')
                if (listEl && player) {
                    listEl.innerHTML = renderAbilityList(player, getTooltip)
                }
            }
            if (target.id === 'buff-player-select' && enc) {
                const dataForTab = filteredEnc || enc
                const guid = target.value
                const selectedPlayer = dataForTab.players.find(p => p.guid === guid)
                if (selectedPlayer) {
                    target.style.color = classColor(selectedPlayer.class_name)
                }
                let buffs = ((dataForTab.buff_uptimes || {})[guid] || []).sort((a: any, b: any) => b.uptime_pct - a.uptime_pct)
                const selfBtn = document.getElementById('buff-self-only')
                if (selfBtn?.getAttribute('data-active') === 'true' && selectedPlayer) {
                    buffs = buffs.filter((b: any) => b.source_name === selectedPlayer.name)
                }
                const dur = dataForTab.duration_secs || 1
                const listEl = document.getElementById('buff-list')
                if (listEl) {
                    listEl.innerHTML = renderBuffList(buffs, dur, getTooltip)
                    setTimeout(() => drawBuffTimelines(buffs, dur), 0)
                }
            }
        }
        document.addEventListener('click', handleClick)
        document.addEventListener('change', handleChange)
        return () => {
            document.removeEventListener('click', handleClick)
            document.removeEventListener('change', handleChange)
        }
    }, [enc, filteredEnc, filename, navigate, getTooltip])

    if (loading) return <div className="loading"><div className="spinner" /><div className="loading-text">Loading encounter...</div></div>
    if (error) return <div className="empty-state"><div className="icon">❌</div><div className="title">Error</div><p>{error}</p></div>
    if (!enc) return <div className="empty-state"><div className="icon">❌</div><div className="title">Encounter not found</div></div>

    // Build encounter pill bar for sessions
    const pillHtml = buildEncounterPills(summary!, enc, encIndex)

    // Stats
    const totalDmg = enc.players.reduce((s, p) => s + p.damage_done, 0)
    const totalHeal = enc.players.reduce((s, p) => s + p.healing_done, 0)
    const typeIcon = enc.encounter_type === 'mythic_plus' ? '🗝️' : enc.encounter_type === 'trash' ? '🗑️' : '⚔️'
    const hasReplay = enc.replay_timeline && enc.replay_timeline.length > 0

    return (
        <>
            <Link to={`/log/${encodeURIComponent(filename!)}`} className="back-btn">← Back to encounters</Link>

            {/* Encounter pill bar */}
            {pillHtml && <div style={{ margin: '12px 0 16px', overflowX: 'auto', scrollbarWidth: 'thin' }} dangerouslySetInnerHTML={{ __html: pillHtml }} />}

            <h1 className="page-title">{typeIcon} {enc.name}</h1>
            <p className="page-subtitle">
                {enc.encounter_type !== 'trash' && (
                    <span className={`encounter-result ${enc.success ? 'kill' : 'wipe'}`} style={{ fontSize: 13 }}>
                        {enc.encounter_type === 'mythic_plus'
                            ? (enc.success ? '✓ Timed' : '✗ Depleted')
                            : (enc.success ? '✓ Kill' : '✗ Wipe')}
                    </span>
                )}
                &nbsp; {formatDuration(enc.duration_secs)} — {enc.difficulty_name} — {enc.group_size} players
            </p>

            <div className="stats-grid">
                <div className="stat-card"><div className="stat-value">{formatNumber(totalDmg)}</div><div className="stat-label">Total Damage</div></div>
                {enc.boss_max_hp != null && (
                    <div className="stat-card">
                        <div className="stat-value" style={{ color: enc.success ? 'var(--accent-green)' : 'var(--accent-orange)' }}>
                            {enc.success ? '0%' : (enc.boss_hp_pct != null ? enc.boss_hp_pct.toFixed(1) + '%' : '?')}
                        </div>
                        <div className="stat-label">Boss HP Left ({formatNumber(enc.boss_max_hp)} max)</div>
                    </div>
                )}
                <div className="stat-card"><div className="stat-value" style={{ color: 'var(--accent-green)' }}>{formatNumber(totalHeal)}</div><div className="stat-label">Total Healing</div></div>
                <div className="stat-card"><div className="stat-value" style={{ color: 'var(--accent-red)' }}>{enc.deaths.length}</div><div className="stat-label">Deaths</div></div>
                <div className="stat-card"><div className="stat-value">{formatDuration(enc.duration_secs)}</div><div className="stat-label">Duration</div></div>
                {enc.boss_encounters.length > 0 && (
                    <div className="stat-card">
                        <div className="stat-value" style={{ color: 'var(--accent-purple)' }}>
                            {enc.boss_encounters.filter(b => b.success).length}/{enc.boss_encounters.length}
                        </div>
                        <div className="stat-label">Bosses Killed</div>
                    </div>
                )}
            </div>

            {/* Segment filter bar for M+ keys */}
            {enc.segments && enc.segments.length > 0 && (
                <div style={{ marginBottom: 16 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                        <span style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 600 }}>FILTER BY SEGMENT</span>
                        <button
                            onClick={() => { setSelectedSegments(null); setSelectedPulls(null) }}
                            style={{
                                fontSize: 11, padding: '2px 10px', borderRadius: 4,
                                border: `1px solid ${selectedSegments === null && selectedPulls === null ? 'var(--accent-purple)' : 'var(--border-color)'}`,
                                background: selectedSegments === null && selectedPulls === null ? 'rgba(139,92,246,0.2)' : 'var(--bg-card)',
                                color: 'var(--text-secondary)', cursor: 'pointer',
                            }}
                        >All</button>
                    </div>
                    <div style={{ display: 'flex', height: 28, borderRadius: 8, overflow: 'hidden', gap: 2 }}>
                        {enc.segments.map((s: any) => {
                            const pct = (s.duration_secs / (enc.duration_secs || 1) * 100).toFixed(1)
                            const bg = s.segment_type === 'boss'
                                ? 'linear-gradient(135deg, var(--accent-purple), var(--accent-blue))'
                                : 'linear-gradient(135deg, rgba(34,197,94,0.4), rgba(34,197,94,0.2))'
                            const isActive = selectedSegments === null || selectedSegments.has(s.index)
                            return (
                                <div
                                    key={s.index}
                                    onClick={(e) => {
                                        setSelectedPulls(null) // Clear pull selection when clicking segments
                                        if (e.ctrlKey || e.metaKey) {
                                            // Multi-select: toggle this segment
                                            setSelectedSegments(prev => {
                                                const cur = prev ?? new Set(enc.segments.map((_: any, i: number) => i))
                                                const next = new Set(cur)
                                                if (next.has(s.index)) {
                                                    next.delete(s.index)
                                                    if (next.size === 0) return null // Don't allow empty
                                                } else {
                                                    next.add(s.index)
                                                }
                                                // If all selected, return null (= all)
                                                if (next.size === enc.segments.length) return null
                                                return next
                                            })
                                        } else {
                                            // Single select: toggle between this-only and all
                                            if (selectedSegments !== null && selectedSegments.size === 1 && selectedSegments.has(s.index)) {
                                                setSelectedSegments(null) // Deselect = show all
                                            } else {
                                                setSelectedSegments(new Set([s.index]))
                                            }
                                        }
                                    }}
                                    style={{
                                        flex: pct,
                                        background: bg,
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                        fontSize: 10,
                                        fontWeight: 700,
                                        minWidth: 18,
                                        cursor: 'pointer',
                                        transition: 'opacity 0.2s, filter 0.2s',
                                        opacity: isActive ? 1 : 0.3,
                                        filter: isActive ? 'none' : 'grayscale(0.5)',
                                    }}
                                    title={`${s.name} (${formatDuration(s.duration_secs)})`}
                                >
                                    {Number(pct) > 6 ? s.name : ''}
                                </div>
                            )
                        })}
                    </div>
                    {/* Pull bar — only shown when exactly one trash segment is selected */}
                    {(() => {
                        // Find the single selected trash segment
                        if (!selectedSegments || selectedSegments.size !== 1) return null
                        const segIdx = Array.from(selectedSegments)[0]
                        const seg = enc.segments.find((s: any) => s.index === segIdx)
                        if (!seg || seg.segment_type !== 'trash' || !seg.pulls || seg.pulls.length === 0) return null

                        const totalPullDur = seg.pulls.reduce((s: number, p: any) => s + (p.duration_secs || 1), 0) || 1
                        return (
                            <div style={{ display: 'flex', height: 22, marginTop: 4, borderRadius: 6, overflow: 'hidden', gap: 2 }}>
                                {seg.pulls.map((pull: any) => {
                                    const pct = (pull.duration_secs / totalPullDur * 100).toFixed(1)
                                    const isPullActive = selectedPulls === null || selectedPulls.has(pull.pull_index)
                                    return (
                                        <div
                                            key={pull.pull_index}
                                            onClick={(e) => {
                                                if (e.ctrlKey || e.metaKey) {
                                                    setSelectedPulls(prev => {
                                                        const cur = prev ?? new Set(seg.pulls.map((pp: any) => pp.pull_index))
                                                        const next = new Set(cur)
                                                        if (next.has(pull.pull_index)) {
                                                            next.delete(pull.pull_index)
                                                            if (next.size === 0) return null
                                                        } else {
                                                            next.add(pull.pull_index)
                                                        }
                                                        if (next.size === seg.pulls.length) return null
                                                        return next
                                                    })
                                                } else {
                                                    if (selectedPulls !== null && selectedPulls.size === 1 && selectedPulls.has(pull.pull_index)) {
                                                        setSelectedPulls(null)
                                                    } else {
                                                        setSelectedPulls(new Set([pull.pull_index]))
                                                    }
                                                }
                                            }}
                                            style={{
                                                flex: pct,
                                                height: '100%',
                                                background: isPullActive ? 'rgba(139,92,246,0.25)' : 'rgba(139,92,246,0.08)',
                                                display: 'flex',
                                                alignItems: 'center',
                                                justifyContent: 'center',
                                                fontSize: 10,
                                                fontWeight: 700,
                                                color: isPullActive ? 'var(--text-secondary)' : 'var(--text-muted)',
                                                cursor: 'pointer',
                                                opacity: isPullActive ? 1 : 0.4,
                                                transition: 'opacity 0.2s, background 0.2s',
                                                minWidth: 18,
                                            }}
                                            title={`Pull ${pull.pull_index + 1} (${formatDuration(pull.duration_secs)})`}
                                        >
                                            {`P${pull.pull_index + 1}`}
                                        </div>
                                    )
                                })}
                            </div>
                        )
                    })()}
                    <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 4 }}>
                        <span style={{ fontSize: 10, color: 'var(--text-muted)', opacity: 0.7 }}>Ctrl+click to multi-select</span>
                    </div>
                </div>
            )}

            {/* Tabs */}
            <div className="tabs">
                {TABS.filter(t => t.always || (t.id === 'replay' && hasReplay)).map(t => (
                    <button
                        key={t.id}
                        className={`tab${activeTab === t.id ? ' active' : ''}`}
                        onClick={() => setActiveTab(t.id)}
                    >
                        {t.icon} {t.label}
                    </button>
                ))}
            </div>

            <div id="tab-content" ref={contentRef} />
        </>
    )
}

// ========== Tab rendering functions (ported from vanilla JS) ==========

function renderTab(
    tab: TabId,
    enc: EncounterSummary,
    getTooltip: (id: number, name?: string) => { icon_url?: string; name?: string; description?: string } | null
): string {
    switch (tab) {
        case 'damage': return renderDamageTab(enc, getTooltip)
        case 'healing': return renderHealingTab(enc, getTooltip)
        case 'taken': return renderDamageTakenTab(enc, getTooltip)
        case 'deaths': return renderDeathsTab(enc, getTooltip)
        case 'abilities': return renderAbilitiesTab(enc, getTooltip)
        case 'enemies': return renderEnemiesTab(enc, getTooltip)
        case 'buffs': return renderBuffUptimeTab(enc, getTooltip)
        case 'replay': return renderReplayTab(enc)
        default: return ''
    }
}

function renderDamageTab(enc: EncounterSummary, getTooltip: (id: number, name?: string) => any): string {
    const maxDmg = Math.max(...enc.players.map(p => p.damage_done), 1)
    if (enc.players.length === 0) return '<div class="empty-state"><div class="title">No damage data</div></div>'

    // Boss HP timeline + slider
    const hasBuckets = enc.time_bucketed_player_damage && Object.keys(enc.time_bucketed_player_damage).length > 0
    const isRaid = enc.encounter_type === 'boss'
    const dur = Math.ceil(enc.duration_secs || 1)
    let sliderHtml = ''
    if (hasBuckets && isRaid) {
        const timeline = enc.boss_hp_timeline || []
        let svgContent = ''
        if (timeline.length > 0) {
            const w = 600, h = 50, maxT = dur
            const pts: [number, number][] = [[0, 100]]
            for (const t of timeline) pts.push([t[0], t[1]])
            pts.push([maxT, pts[pts.length - 1][1]])
            const pathD = 'M' + pts.map(p => `${(p[0] / maxT * w).toFixed(1)},${((100 - p[1]) / 100 * h).toFixed(1)}`).join(' L')
            svgContent = `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="width:100%;height:50px;display:block">
        <path d="${pathD} L${w},${h} L0,${h} Z" fill="url(#hpGrad)" opacity="0.3"/>
        <path d="${pathD}" fill="none" stroke="var(--accent-red)" stroke-width="1.5"/>
        <defs><linearGradient id="hpGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="var(--accent-red)" stop-opacity="0.6"/><stop offset="100%" stop-color="var(--accent-red)" stop-opacity="0.05"/></linearGradient></defs>
      </svg>`
        }
        const fmtTime = (s: number) => { const m = Math.floor(s / 60); const sec = s % 60; return m + ':' + (sec < 10 ? '0' : '') + sec }
        sliderHtml = `<div style="margin-bottom:20px;padding:16px 20px;background:var(--bg-card);border:1px solid var(--border-color);border-radius:12px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
        <span style="font-size:13px;font-weight:600;color:var(--text-secondary)">⏱️ Fight Timeline</span>
        <span id="timeline-range-label" style="font-size:13px;font-weight:700;color:var(--accent-cyan)">${fmtTime(0)} — ${fmtTime(dur)}</span>
      </div>
      ${svgContent ? `<div style="margin-bottom:4px;border-radius:6px;overflow:hidden;border:1px solid var(--border-color);background:var(--bg-secondary)">
        <div style="display:flex;justify-content:space-between;padding:0 6px;font-size:9px;color:var(--text-muted);margin-top:2px"><span>100%</span><span style="color:var(--accent-red)">Boss HP</span><span>0%</span></div>
        ${svgContent}</div>` : ''}
      <div style="position:relative;height:24px;margin-top:8px">
        <div style="position:absolute;top:10px;left:0;right:0;height:4px;background:var(--bg-secondary);border-radius:2px"></div>
        <div id="timeline-range-fill" style="position:absolute;top:10px;left:0;right:0;height:4px;background:var(--accent-cyan);border-radius:2px;opacity:0.5"></div>
        <input type="range" id="timeline-start" min="0" max="${dur}" value="0" step="1" style="position:absolute;top:0;left:0;width:100%;height:24px;-webkit-appearance:none;appearance:none;background:transparent;pointer-events:none;margin:0;z-index:2" />
        <input type="range" id="timeline-end" min="0" max="${dur}" value="${dur}" step="1" style="position:absolute;top:0;left:0;width:100%;height:24px;-webkit-appearance:none;appearance:none;background:transparent;pointer-events:none;margin:0;z-index:3" />
      </div>
      <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text-muted);margin-top:4px">
        <span>0:00 (Pull)</span><span>${fmtTime(dur)} (End)</span>
      </div>
    </div>`
    }

    const sorted = [...enc.players].sort((a, b) => b.damage_done - a.damage_done)
    return sliderHtml + `<table class="data-table">
    <thead><tr><th>#</th><th>Player</th><th>Damage Done</th><th></th><th class="num">DPS</th></tr></thead>
    <tbody>${sorted.map((p, i) => {
        const pid = `dmg-${p.guid.replace(/[^a-zA-Z0-9]/g, '')}`
        const ri = roleIcon(p.role)
        return `<tr class="animate-in player-row" style="animation-delay:${i * 20}ms;cursor:pointer" data-toggle-detail="${pid}">
        <td class="rank ${i < 3 ? 'rank-' + (i + 1) : ''}">${i + 1}</td>
        <td><span title="${ri.label}" style="font-size:12px;margin-right:4px">${ri.icon}</span><strong style="color:${classColor(p.class_name)}">${p.name}</strong>${p.spec_name ? `<span style="color:${classColor(p.class_name)};opacity:0.6;font-size:11px;margin-left:6px">${p.spec_name} ${p.class_name}</span>` : ''}</td>
        <td class="num">${formatNumber(p.damage_done)}</td>
        <td class="bar-cell"><div class="bar-container"><div class="bar-fill" style="width:${(p.damage_done / maxDmg * 100).toFixed(1)}%;background:linear-gradient(90deg, var(--accent-purple), var(--accent-blue));opacity:0.8"></div><div class="bar-label">${formatNumber(p.damage_done)}</div></div></td>
        <td class="num" style="color:var(--accent-orange);font-weight:600">${formatNumber(Math.round(p.dps))}</td>
      </tr>
      <tr id="${pid}" class="detail-row" style="display:none">
        <td colspan="5" style="padding:0">
          <div style="display:flex;gap:8px;padding:8px 12px 0 12px">
            <button data-detail-pid="${pid}" data-detail-tab="abilities" style="padding:4px 12px;font-size:11px;font-weight:600;border:1px solid var(--accent-purple);background:rgba(139,92,246,0.13);color:var(--accent-purple);border-radius:6px;cursor:pointer">Abilities</button>
            <button data-detail-pid="${pid}" data-detail-tab="targets" style="padding:4px 12px;font-size:11px;font-weight:600;border:1px solid var(--border-color);background:transparent;color:var(--text-muted);border-radius:6px;cursor:pointer">Targets</button>
          </div>
          <div id="${pid}-abilities" class="ability-panel">${renderAbilityBreakdown(p.abilities || [], p.damage_done, getTooltip)}</div>
          <div id="${pid}-targets" class="ability-panel" style="display:none">${renderTargetBreakdown(p.abilities || [], p.damage_done, getTooltip)}</div>
        </td>
      </tr>`
    }).join('')}</tbody></table>`
}

function renderHealingTab(enc: EncounterSummary, getTooltip: (id: number, name?: string) => any): string {
    const sorted = [...enc.players].filter(p => p.healing_done > 0).sort((a, b) => b.healing_done - a.healing_done)
    if (sorted.length === 0) return '<div class="empty-state"><div class="title">No healing data</div></div>'
    const maxHeal = Math.max(...sorted.map(p => p.healing_done), 1)
    return `<table class="data-table">
    <thead><tr><th>#</th><th>Player</th><th>Healing Done</th><th></th><th class="num">HPS</th></tr></thead>
    <tbody>${sorted.map((p, i) => {
        const pid = `heal-${p.guid.replace(/[^a-zA-Z0-9]/g, '')}`
        const abilities = (p.heal_abilities?.length > 0) ? p.heal_abilities : (p.abilities || [])
        return `<tr class="animate-in player-row" style="animation-delay:${i * 20}ms;cursor:pointer" data-toggle-detail="${pid}">
        <td class="rank ${i < 3 ? 'rank-' + (i + 1) : ''}">${i + 1}</td>
        <td><strong style="color:${classColor(p.class_name)}">${p.name}</strong>${p.spec_name ? `<span style="color:${classColor(p.class_name)};opacity:0.6;font-size:11px;margin-left:6px">${p.spec_name} ${p.class_name}</span>` : ''}</td>
        <td class="num">${formatNumber(p.healing_done)}</td>
        <td class="bar-cell"><div class="bar-container"><div class="bar-fill" style="width:${(p.healing_done / maxHeal * 100).toFixed(1)}%;background:linear-gradient(90deg, var(--accent-green), var(--accent-cyan));opacity:0.8"></div><div class="bar-label">${formatNumber(p.healing_done)}</div></div></td>
        <td class="num" style="color:var(--accent-green);font-weight:600">${formatNumber(Math.round(p.hps))}</td>
      </tr>
      <tr id="${pid}" class="detail-row" style="display:none">
        <td colspan="5" style="padding:0"><div class="ability-panel">${renderAbilityBreakdown(abilities, p.healing_done, getTooltip)}</div></td>
      </tr>`
    }).join('')}</tbody></table>`
}

function renderDamageTakenTab(enc: EncounterSummary, getTooltip: (id: number, name?: string) => any): string {
    const sorted = [...enc.players].filter(p => (p.damage_taken || 0) > 0).sort((a, b) => (b.damage_taken || 0) - (a.damage_taken || 0))
    if (sorted.length === 0) return '<div class="empty-state"><div class="title">No damage taken data</div></div>'
    const maxTaken = Math.max(...sorted.map(p => p.damage_taken || 0), 1)
    const dur = enc.duration_secs || 1
    return `<table class="data-table">
    <thead><tr><th>#</th><th>Player</th><th>Damage Taken</th><th></th><th>DTPS</th></tr></thead>
    <tbody>${sorted.map((p, i) => {
        const pid = `taken-${p.guid.replace(/[^a-zA-Z0-9]/g, '')}`
        const dtps = Math.round((p.damage_taken || 0) / dur)
        return `<tr class="animate-in player-row" style="animation-delay:${i * 20}ms;cursor:pointer" data-toggle-detail="${pid}">
        <td class="rank ${i < 3 ? 'rank-' + (i + 1) : ''}">${i + 1}</td>
        <td><strong style="color:${classColor(p.class_name)}">${p.name}</strong>${p.spec_name ? `<span style="color:${classColor(p.class_name)};opacity:0.6;font-size:11px;margin-left:6px">${p.spec_name} ${p.class_name}</span>` : ''}</td>
        <td class="num">${formatNumber(p.damage_taken || 0)}</td>
        <td class="bar-cell"><div class="bar-container"><div class="bar-fill" style="width:${((p.damage_taken || 0) / maxTaken * 100).toFixed(1)}%;background:linear-gradient(90deg, var(--accent-red), var(--accent-orange));opacity:0.8"></div></div></td>
        <td class="num dps">${formatNumber(dtps)}</td>
      </tr>
      <tr id="${pid}" class="detail-row" style="display:none">
        <td colspan="5" style="padding:0"><div class="ability-panel">${renderAbilityBreakdown(p.damage_taken_abilities || [], p.damage_taken || 0, getTooltip)}</div></td>
      </tr>`
    }).join('')}</tbody></table>`
}

function renderDeathsTab(enc: EncounterSummary, getTooltip: (id: number, name?: string) => any): string {
    const deaths = enc.deaths || []
    if (deaths.length === 0) return '<div class="empty-state"><div class="icon">🎉</div><div class="title">No deaths!</div></div>'
    return deaths.map((d, i) => {
        const fmtTime = (s: number) => { const m = Math.floor(s / 60); const sec = Math.floor(s % 60); return m + ':' + (sec < 10 ? '0' : '') + sec }
        const hasRecap = d.recap && d.recap.length > 0
        // Killing blow info
        const kbSpell = d.killing_blow_spell || 'Unknown'
        const kbSource = d.killing_blow_source || ''
        const kbAmount = d.killing_blow_amount || 0
        const overkill = d.overkill || 0
        // Killing blow summary line
        const killingBlowHtml = `<div style="display:flex;align-items:center;gap:12px;padding:10px 16px;margin-bottom:2px;background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.2);border-radius:8px;flex-wrap:wrap">
            <span style="font-size:14px">⚔</span>
            <span style="background:var(--accent-red);color:white;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:700;letter-spacing:0.5px">KILLING BLOW</span>
            ${kbAmount > 0 ? `<span style="color:var(--accent-red);font-weight:700;font-size:13px">-${formatNumber(kbAmount)}</span>` : ''}
            <span style="color:var(--accent-blue);font-weight:600;font-size:13px">${kbSpell}</span>
            ${kbSource ? `<span style="color:var(--text-muted);font-size:12px">${kbSource}</span>` : ''}
            <span style="flex:1"></span>
            ${kbSource ? `<span style="color:var(--text-secondary);font-size:12px">${kbSource}</span>` : ''}
            ${overkill > 0 ? `<span style="background:rgba(239,68,68,0.15);color:var(--accent-red);padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600">Overkill: ${formatNumber(overkill)}</span>` : ''}
          </div>`
        return `<div class="death-item animate-in" style="animation-delay:${i * 30}ms">
      <div class="death-header" data-toggle-recap="${i}">
        <span class="expand-icon">${hasRecap ? '▶' : ''}</span>
        <span class="death-time">${fmtTime(d.time_into_fight_secs)}</span>
        <span class="death-player">${d.player_name}</span>
        <span class="death-source">Killed by ${kbSource}${kbSpell !== 'Unknown' ? ` with ${kbSpell}` : ''}</span>
      </div>
      ${hasRecap ? `<div id="recap-${i}" class="death-recap">
        ${killingBlowHtml}
        <table style="width:100%;border-collapse:collapse;font-size:12px;margin-top:4px">
        ${[...d.recap].reverse().map(r => {
            const hpPct = r.max_hp > 0 ? (r.current_hp / r.max_hp * 100) : 0
            const hpColor = hpPct > 50 ? 'var(--accent-green)' : (hpPct > 20 ? 'var(--accent-orange)' : 'var(--accent-red)')
            // Event type badge
            const evType = r.event_type.toLowerCase()
            let badgeBg = 'rgba(100,100,100,0.3)'
            let badgeColor = 'var(--text-secondary)'
            let badgeLabel = r.event_type.replace('_', ' ').toUpperCase()
            if (evType === 'damage') { badgeBg = 'rgba(239,68,68,0.2)'; badgeColor = 'var(--accent-red)'; badgeLabel = 'DMG' }
            else if (evType === 'healing') { badgeBg = 'rgba(34,197,94,0.2)'; badgeColor = 'var(--accent-green)'; badgeLabel = 'HEAL' }
            else if (evType === 'buff_applied' || evType === 'buff') { badgeBg = 'rgba(59,130,246,0.2)'; badgeColor = 'var(--accent-blue)'; badgeLabel = 'BUFF' }
            else if (evType === 'buff_removed' || evType === 'faded') { badgeBg = 'rgba(234,179,8,0.2)'; badgeColor = 'var(--accent-gold)'; badgeLabel = 'FADED' }
            else if (evType === 'death') { badgeBg = 'rgba(239,68,68,0.3)'; badgeColor = 'var(--accent-red)'; badgeLabel = 'DEATH' }
            // Amount formatting
            const amtPrefix = evType === 'healing' ? '+' : evType === 'damage' || evType === 'death' ? '-' : ''
            const amtColor = evType === 'healing' ? 'var(--accent-green)' : evType === 'damage' || evType === 'death' ? 'var(--accent-red)' : 'var(--text-muted)'
            const amtStr = r.amount > 0 ? `${amtPrefix}${formatNumber(r.amount)}` : '—'
            return `<tr style="border-bottom:1px solid rgba(255,255,255,0.03)">
              <td style="padding:5px 8px;color:var(--text-muted);width:40px;white-space:nowrap">${fmtTime(r.time_into_fight_secs)}</td>
              <td style="padding:5px 6px;width:50px"><span style="background:${badgeBg};color:${badgeColor};padding:1px 6px;border-radius:3px;font-size:10px;font-weight:700;letter-spacing:0.3px">${badgeLabel}</span></td>
              <td style="padding:5px 6px;width:60px;text-align:right;font-weight:600;color:${amtColor};font-size:12px">${amtStr}</td>
              <td style="padding:5px 8px">${spellHtml(r.spell_id, r.spell_name, r.wowhead_url, getTooltip, { color: 'var(--accent-blue)', iconSize: 16 })}</td>
              <td style="padding:5px 8px;color:var(--text-muted);font-size:11px">${r.source_name}</td>
              <td style="padding:5px 8px;width:120px">
                <div style="display:flex;align-items:center;gap:4px">
                  <div style="flex:1;height:14px;background:rgba(255,255,255,0.05);border-radius:3px;overflow:hidden;position:relative">
                    <div style="height:100%;width:${hpPct.toFixed(0)}%;background:${hpColor};border-radius:3px;transition:width 0.3s"></div>
                  </div>
                  <span style="font-size:10px;color:var(--text-muted);min-width:28px;text-align:right">${hpPct.toFixed(0)}%</span>
                </div>
              </td>
            </tr>`
        }).join('')}
        </table>
      </div>` : ''}
    </div>`
    }).join('')
}

function renderAbilitiesTab(enc: EncounterSummary, getTooltip: (id: number, name?: string) => any): string {
    if (enc.players.length === 0) return '<div class="empty-state"><div class="title">No ability data</div></div>'
    const firstGuid = enc.players[0]?.guid
    return `<div style="display:flex;gap:12px;margin-bottom:16px;flex-wrap:wrap;align-items:center">
    <span style="font-size:12px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;font-weight:600">Select Player</span>
    <select id="ability-player-select" style="padding:8px 14px;background:var(--bg-card);border:1px solid var(--border-color);border-radius:8px;color:var(--text-primary);font-size:13px;min-width:220px">
      ${enc.players.map(p => `<option value="${p.guid}" ${p.guid === firstGuid ? 'selected' : ''} style="color:${classColor(p.class_name)}">${p.name} — ${p.spec_name || ''} ${p.class_name}</option>`).join('')}
    </select>
    <input id="ability-search" type="text" placeholder="🔍 Search abilities..." style="padding:8px 14px;background:var(--bg-input);border:1px solid var(--border-color);border-radius:8px;color:var(--text-primary);font-size:13px;width:200px">
  </div>
  <div id="ability-list">${renderAbilityList(enc.players[0], getTooltip)}</div>`
}

function renderAbilityList(player: PlayerSummary | undefined, getTooltip: (id: number, name?: string) => any): string {
    if (!player) return ''
    const abilities = [...(player.abilities || [])].sort((a, b) => b.total_amount - a.total_amount)
    if (abilities.length === 0) return '<div class="empty-state"><div class="title">No abilities recorded</div></div>'
    const max = abilities[0].total_amount || 1
    const totalDmg = abilities.reduce((s, a) => s + a.total_amount, 0) || 1
    return `<table class="data-table">
    <thead><tr><th>#</th><th>Ability</th><th>Hits</th><th>Total</th><th></th><th>%</th></tr></thead>
    <tbody>${abilities.map((a, i) => {
        const pct = (a.total_amount / totalDmg * 100).toFixed(1)
        return `<tr class="ability-row">
      <td class="rank">${i + 1}</td>
      <td class="ability-cell">${spellHtml(a.spell_id, a.spell_name, a.wowhead_url, getTooltip, { color: getSchoolColor(a.spell_school) })}</td>
      <td class="num">${a.hit_count.toLocaleString()}</td>
      <td class="num">${formatNumber(a.total_amount)}</td>
      <td class="bar-cell"><div class="bar-container"><div class="bar-fill" style="width:${(a.total_amount / max * 100).toFixed(1)}%;background:${getSchoolColor(a.spell_school)};opacity:0.6"></div></div></td>
      <td class="num" style="color:var(--text-muted);font-size:12px">${pct}%</td>
    </tr>`
    }).join('')}</tbody></table>`
}

function renderEnemiesTab(enc: EncounterSummary, getTooltip: (id: number, name?: string) => any): string {
    const enemies = enc.enemy_breakdowns || []
    if (enemies.length === 0) return '<div class="empty-state"><div class="title">No enemy data</div></div>'
    const sorted = [...enemies].sort((a, b) => b.total_damage - a.total_damage)
    const dur = enc.duration_secs || 1
    // Build a bar for the enemy header (max across all enemies)
    const maxEnemyDmg = Math.max(...sorted.map(e => e.total_damage), 1)
    return `<div>${sorted.map((e, i) => {
        const maxPlayerDmg = Math.max(...e.players.map(p => p.damage), 1)
        const playerCount = e.players.length
        const enemyBarPct = (e.total_damage / maxEnemyDmg * 100).toFixed(1)
        return `<div class="death-item animate-in" style="animation-delay:${i * 30}ms">
      <div class="death-header" data-toggle-enemy="${i}" style="cursor:pointer">
        <span class="expand-icon">▶</span>
        <span style="color:var(--text-muted);font-size:11px;margin-right:4px">${e.mob_type}</span>
        <span style="flex:0 0 auto;font-weight:600">${e.target_name}</span>
        ${e.kill_count > 0 ? `<span style="font-size:11px;color:var(--accent-green);margin-left:6px">× ${e.kill_count} killed</span>` : ''}
        <span style="flex:1;margin:0 12px"><div class="bar-container" style="height:16px;max-width:300px"><div class="bar-fill" style="width:${enemyBarPct}%;background:linear-gradient(90deg, var(--accent-orange), var(--accent-red));opacity:0.5"></div></div></span>
        <span style="font-weight:600;color:var(--accent-gold)">${formatNumber(e.total_damage)}</span>
        <span style="font-size:11px;color:var(--text-muted);margin-left:8px">${playerCount} players</span>
      </div>
      <div id="enemy-${i}" style="display:none;padding:8px 18px 14px;border-top:1px solid var(--border-color)">
        <table class="data-table" style="font-size:13px">
          <thead><tr><th style="width:30px">#</th><th>Player</th><th>Class</th><th>Damage</th><th></th><th>DPS</th><th>% of Total</th></tr></thead>
          <tbody>${e.players.sort((a, b) => b.damage - a.damage).map((p, pi) => {
            const pct = e.total_damage > 0 ? (p.damage / e.total_damage * 100).toFixed(1) : '0.0'
            const dps = Math.round(p.damage / dur)
            const detailId = `enemy-${i}-player-${pi}`
            // Find the full player data for ability breakdown
            const fullPlayer = enc.players.find(fp => fp.name === p.player_name)
            return `<tr class="player-row" style="cursor:pointer" data-toggle-detail="${detailId}">
            <td class="rank ${pi < 3 ? 'rank-' + (pi + 1) : ''}">${pi + 1}</td>
            <td><strong style="color:${classColor(p.class_name)}">${p.player_name}</strong></td>
            <td style="color:${classColor(p.class_name)};opacity:0.6;font-size:12px">${p.class_name}</td>
            <td class="num">${formatNumber(p.damage)}</td>
            <td class="bar-cell"><div class="bar-container" style="height:18px"><div class="bar-fill" style="width:${(p.damage / maxPlayerDmg * 100).toFixed(1)}%;background:${classColor(p.class_name)};opacity:0.6"></div></div></td>
            <td class="num dps">${formatNumber(dps)}</td>
            <td class="num" style="color:var(--text-muted);font-size:12px">${pct}%</td>
          </tr>
          <tr id="${detailId}" class="detail-row" style="display:none">
            <td colspan="7" style="padding:0"><div class="ability-panel">${fullPlayer ? renderAbilityBreakdown(fullPlayer.abilities || [], fullPlayer.damage_done || 0, getTooltip) : '<div style="padding:12px;color:var(--text-muted)">No ability data</div>'}</div></td>
          </tr>`
        }).join('')}</tbody>
        </table>
      </div>
    </div>`
    }).join('')}</div>`
}

function renderAbilityBreakdown(abilities: AbilityBreakdown[], totalAmount: number, getTooltip: (id: number, name?: string) => any): string {
    const sorted = [...abilities].sort((a, b) => b.total_amount - a.total_amount).slice(0, 20)
    if (sorted.length === 0) return '<div style="padding:12px;color:var(--text-muted)">No ability data</div>'
    const maxAbility = Math.max(...sorted.map(a => a.total_amount), 1)
    return `<table style="width:100%;border-collapse:collapse">${sorted.map(a => {
        const pct = totalAmount > 0 ? (a.total_amount / totalAmount * 100).toFixed(1) : '0.0'
        const barW = (a.total_amount / maxAbility * 100).toFixed(1)
        return `<tr class="ability-row">
      <td style="padding:6px 12px;width:30%;white-space:nowrap">
        ${spellHtml(a.spell_id, a.spell_name, a.wowhead_url, getTooltip, { color: getSchoolColor(a.spell_school), iconSize: 18, stopClick: true })}
        <span style="color:var(--text-muted);font-size:11px;margin-left:4px">${a.hit_count} hits</span>
      </td>
      <td style="padding:6px 8px;width:50%">
        <div style="position:relative;height:18px;background:rgba(255,255,255,0.03);border-radius:4px;overflow:hidden">
          <div style="height:100%;width:${barW}%;background:linear-gradient(90deg, rgba(139,92,246,0.4), rgba(59,130,246,0.4));border-radius:4px"></div>
          <span style="position:absolute;left:8px;top:1px;font-size:11px;color:var(--text-secondary)">${formatNumber(a.total_amount)}</span>
        </div>
      </td>
      <td style="padding:6px 12px;text-align:right;font-size:13px;color:var(--text-secondary);font-weight:500">${pct}%</td>
    </tr>`
    }).join('')}</table>`
}

function renderTargetBreakdown(abilities: AbilityBreakdown[], totalAmount: number, getTooltip: (id: number, name?: string) => any): string {
    const byTarget: Record<string, number> = {}
    for (const a of abilities) {
        if (a.targets) {
            for (const t of a.targets) { byTarget[t.target_name] = (byTarget[t.target_name] || 0) + t.amount }
        }
    }
    const sorted = Object.entries(byTarget).sort(([, a], [, b]) => b - a)
    if (sorted.length === 0) return '<div style="padding:12px;color:var(--text-muted)">No target data</div>'
    const maxTarget = Math.max(...sorted.map(([, a]) => a), 1)
    return `<table style="width:100%;border-collapse:collapse">${sorted.map(([name, amount]) => {
        const pct = totalAmount > 0 ? (amount / totalAmount * 100).toFixed(1) : '0.0'
        const barW = (amount / maxTarget * 100).toFixed(1)
        return `<tr class="ability-row">
      <td style="padding:6px 12px;width:30%;white-space:nowrap;font-weight:500;color:var(--text-primary)">${name}</td>
      <td style="padding:6px 8px;width:50%">
        <div style="position:relative;height:18px;background:rgba(255,255,255,0.03);border-radius:4px;overflow:hidden">
          <div style="height:100%;width:${barW}%;background:linear-gradient(90deg, rgba(239,68,68,0.4), rgba(249,115,22,0.4));border-radius:4px"></div>
          <span style="position:absolute;left:8px;top:1px;font-size:11px;color:var(--text-secondary)">${formatNumber(amount)}</span>
        </div>
      </td>
      <td style="padding:6px 12px;text-align:right;font-size:13px;color:var(--text-secondary);font-weight:500">${pct}%</td>
    </tr>`
    }).join('')}</table>`
}

function renderBuffUptimeTab(enc: EncounterSummary, getTooltip: (id: number, name?: string) => any): string {
    const players = enc.players || []
    if (players.length === 0) return '<div class="empty-state"><div class="title">No buff data</div></div>'
    const firstGuid = players[0]?.guid
    const firstColor = classColor(players[0]?.class_name || '')
    const uptimes = enc.buff_uptimes || {}
    const dur = enc.duration_secs || 1
    const firstBuffs = (uptimes[firstGuid] || []).sort((a: any, b: any) => b.uptime_pct - a.uptime_pct)

    return `<div style="display:flex;gap:12px;margin-bottom:16px;flex-wrap:wrap;align-items:center">
    <span style="font-size:12px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;font-weight:600">Select Player</span>
    <select id="buff-player-select" style="padding:8px 14px;background:var(--bg-card);border:1px solid var(--border-color);border-radius:8px;color:${firstColor};font-size:13px;min-width:220px">
      ${players.map(p => `<option value="${p.guid}" ${p.guid === firstGuid ? 'selected' : ''} style="color:${classColor(p.class_name)}">${p.name} \u2014 ${p.spec_name || ''} ${p.class_name}</option>`).join('')}
    </select>
    <button id="buff-self-only" data-active="false" style="padding:6px 14px;background:var(--bg-card);border:1px solid var(--border-color);border-radius:8px;color:var(--text-muted);font-size:12px;cursor:pointer;transition:all 0.2s">Self Only</button>
    <input id="buff-search" type="text" placeholder="\ud83d\udd0d Search buffs..." style="padding:8px 14px;background:var(--bg-input);border:1px solid var(--border-color);border-radius:8px;color:var(--text-primary);font-size:13px;width:200px;margin-left:auto">
  </div>
  <div id="buff-list">${renderBuffList(firstBuffs, dur, getTooltip)}</div>`
}

function renderBuffList(buffs: any[], dur: number, getTooltip: (id: number, name?: string) => any): string {
    if (buffs.length === 0) return '<div style="color:var(--text-muted);padding:16px;font-size:13px">No buff data for this player</div>'
    const fmtDur = (s: number) => { const m = Math.floor(s / 60); const sec = Math.floor(s % 60); return m + ':' + (sec < 10 ? '0' : '') + sec }
    return `<table class="data-table" style="font-size:13px"><thead><tr><th>Buff</th><th>Source</th><th class="num">Uptime</th><th style="width:120px"></th><th>Timeline</th></tr></thead>
      <tbody>${buffs.map((b: any, i: number) => {
        const uptimeDur = b.uptime_secs || Math.round(dur * b.uptime_pct / 100)
        const barPct = Math.min(b.uptime_pct, 100).toFixed(1)
        return `<tr class="animate-in" style="animation-delay:${i * 15}ms">
        <td class="ability-cell">${spellHtml(b.spell_id, b.spell_name, b.wowhead_url, getTooltip, { iconSize: 18, color: 'var(--accent-cyan)' })}</td>
        <td style="font-size:12px;color:var(--text-muted)">${b.source_name || ''}</td>
        <td class="num" style="color:${b.uptime_pct >= 80 ? 'var(--accent-green)' : b.uptime_pct >= 50 ? 'var(--accent-orange)' : 'var(--accent-red)'};font-weight:700">${b.uptime_pct.toFixed(1)}%</td>
        <td style="width:120px"><div style="position:relative;height:20px;background:rgba(255,255,255,0.04);border-radius:4px;overflow:hidden"><div style="height:100%;width:${barPct}%;background:linear-gradient(90deg, rgba(124,58,237,0.7), rgba(99,102,241,0.7));border-radius:4px"></div><span style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);font-size:11px;color:var(--text-primary);font-weight:600;white-space:nowrap;text-shadow:0 1px 2px rgba(0,0,0,0.5)">${fmtDur(uptimeDur)}</span></div></td>
        <td style="min-width:200px"><canvas class="buff-canvas" data-buff-idx="${i}" width="400" height="24" style="width:100%;height:24px;border-radius:4px;background:rgba(255,255,255,0.03)"></canvas></td>
      </tr>`
    }).join('')}</tbody></table>`
}

function renderReplayTab(enc: EncounterSummary): string {
    if (!enc.replay_timeline || enc.replay_timeline.length === 0) {
        return '<div class="empty-state"><div class="icon">🎬</div><div class="title">No replay data</div><p>HP data not available for this encounter.</p></div>'
    }
    const dur = enc.duration_secs || 1
    const fmtTime = (s: number) => { const m = Math.floor(s / 60); const sec = Math.floor(s % 60); return m + ':' + (sec < 10 ? '0' : '') + sec }

    // Check for position data
    const hasPositions = enc.replay_timeline.some(s => s.pos_x != null && s.pos_y != null)

    // Get unique player info
    const playerGuids = [...new Set(enc.replay_timeline.map(s => s.guid))]
    const playerInfo: Record<string, { name: string; class_name: string; max_hp: number }> = {}
    for (const s of enc.replay_timeline) {
        if (!playerInfo[s.guid]) playerInfo[s.guid] = { name: s.name, class_name: s.class_name, max_hp: s.max_hp }
        if (s.max_hp > playerInfo[s.guid].max_hp) playerInfo[s.guid].max_hp = s.max_hp
    }

    // Death markers
    const deathMarkers = (enc.deaths || []).map(d => {
        const pct = (d.time_into_fight_secs / dur * 100).toFixed(2)
        return `<span class="replay-death-marker" style="left:${pct}%" title="💀 ${d.player_name} died at ${fmtTime(d.time_into_fight_secs)}${d.killing_blow_spell ? ' — ' + d.killing_blow_spell : ''}">💀</span>`
    }).join('')

    // Boss HP section
    const hasBossHp = enc.boss_hp_timeline && enc.boss_hp_timeline.length > 0
    const bossSection = hasBossHp ? `<div class="replay-boss-hp">
      <div class="replay-boss-hp-label">BOSS HP — ${enc.name}</div>
      <div class="replay-boss-hp-bar"><div class="replay-boss-hp-fill" id="replay-boss-fill" style="width:100%"></div><div class="replay-boss-hp-text" id="replay-boss-text">100%</div></div>
    </div>` : ''

    // Raid frames HTML
    const raidFramesHtml = playerGuids.map(guid => {
        const info = playerInfo[guid]
        const color = classColor(info.class_name)
        const safeId = guid.replace(/[^a-zA-Z0-9]/g, '_')
        return `<div class="raid-frame" id="rf-${safeId}">
          <div class="raid-frame-bg" style="background:${color}"></div>
          <div class="raid-frame-fill" id="rf-fill-${safeId}" style="width:100%;background:${color};opacity:0.7"></div>
          <div class="raid-frame-deficit" id="rf-def-${safeId}" style="width:0%"></div>
          <div class="raid-frame-content">
            <div class="raid-frame-name">${info.name.split('-')[0]}</div>
            <div class="raid-frame-hp" id="rf-hp-${safeId}">${formatNumber(info.max_hp)}</div>
          </div>
        </div>`
    }).join('')

    // Map section
    const mapSection = hasPositions ? `<div class="replay-map-wrap">
      <div class="replay-map-label">Position Map</div>
      <canvas class="replay-map-canvas" id="replay-map"></canvas>
    </div>` : ''

    return `<div class="replay-container">
    <div class="replay-controls">
      <button id="replay-play-btn" title="Play / Pause">▶</button>
      <input type="range" class="replay-slider" id="replay-slider" min="0" max="${(dur * 10).toFixed(0)}" value="0" step="1">
      <div class="replay-time" id="replay-time">0:00 / ${fmtTime(dur)}</div>
      <div class="replay-speed" id="replay-speed-btn" title="Click to change speed">1×</div>
    </div>
    <div class="replay-death-markers" id="replay-markers">${deathMarkers}</div>
    ${bossSection}
    <div class="replay-map-section">
      <div class="replay-raid-frames">
        <div class="replay-raid-label">Party / Raid Frames</div>
        <div class="replay-frames-grid" id="replay-frames">${raidFramesHtml}</div>
      </div>
      ${mapSection}
    </div>
  </div>`
}

// ========== Interactive handlers ==========

function showDetailTab(pid: string, tab: string) {
    const abilities = document.getElementById(`${pid}-abilities`)
    const targets = document.getElementById(`${pid}-targets`)
    if (abilities) abilities.style.display = tab === 'abilities' ? '' : 'none'
    if (targets) targets.style.display = tab === 'targets' ? '' : 'none'
    // Update button styles
    const abBtn = document.querySelector(`[data-detail-pid="${pid}"][data-detail-tab="abilities"]`) as HTMLElement
    const tgBtn = document.querySelector(`[data-detail-pid="${pid}"][data-detail-tab="targets"]`) as HTMLElement
    if (abBtn) {
        abBtn.style.borderColor = tab === 'abilities' ? 'var(--accent-purple)' : 'var(--border-color)'
        abBtn.style.background = tab === 'abilities' ? 'rgba(139,92,246,0.13)' : 'transparent'
        abBtn.style.color = tab === 'abilities' ? 'var(--accent-purple)' : 'var(--text-muted)'
    }
    if (tgBtn) {
        tgBtn.style.borderColor = tab === 'targets' ? 'var(--accent-purple)' : 'var(--border-color)'
        tgBtn.style.background = tab === 'targets' ? 'rgba(139,92,246,0.13)' : 'transparent'
        tgBtn.style.color = tab === 'targets' ? 'var(--accent-purple)' : 'var(--text-muted)'
    }
}

// selectBuffPlayer is now handled via the buff-player-select dropdown change handler

// ========== Canvas-based rendering ==========

function drawBuffTimelines(buffs: any[], duration: number) {
    const canvases = document.querySelectorAll('.buff-canvas')
    canvases.forEach((canvas, i) => {
        if (i >= buffs.length) return
        const c = canvas as HTMLCanvasElement
        const ctx = c.getContext('2d')
        if (!ctx) return
        const w = c.width, h = c.height
        ctx.clearRect(0, 0, w, h)
        const b = buffs[i]
        if (!b?.timeline?.length) return

        let currentStacks = 0
        const maxStacks = b.max_stacks || 1
        const events = b.timeline.sort((a: any, b: any) => a.time - b.time)
        let lastTime = 0

        for (const ev of events) {
            if (ev.event_type === 'apply' || ev.event_type === 'stack') {
                if (currentStacks > 0 && ev.time > lastTime) {
                    drawUptimeBar(ctx, lastTime / duration * w, ev.time / duration * w, currentStacks, maxStacks, h)
                }
                currentStacks = ev.stacks || (currentStacks + 1)
                lastTime = ev.time
            } else if (ev.event_type === 'remove') {
                if (currentStacks > 0 && ev.time > lastTime) {
                    drawUptimeBar(ctx, lastTime / duration * w, ev.time / duration * w, currentStacks, maxStacks, h)
                }
                currentStacks = 0
                lastTime = ev.time
            }
        }
        if (currentStacks > 0 && lastTime < duration) {
            drawUptimeBar(ctx, lastTime / duration * w, w, currentStacks, maxStacks, h)
        }
    })
}

function drawUptimeBar(ctx: CanvasRenderingContext2D, x1: number, x2: number, stacks: number, maxStacks: number, h: number) {
    const alpha = maxStacks > 1 ? 0.2 + 0.6 * (stacks / maxStacks) : 0.6
    ctx.fillStyle = `rgba(6, 182, 212, ${alpha})`
    ctx.fillRect(x1, 0, x2 - x1, h)
}

// ========== Replay controls ==========

function initReplayControls(enc: EncounterSummary) {
    // Cancel any previous replay animation
    if ((window as any).__replayCleanup) { (window as any).__replayCleanup(); (window as any).__replayCleanup = null }

    const slider = document.getElementById('replay-slider') as HTMLInputElement
    const timeDisplay = document.getElementById('replay-time')
    const playBtn = document.getElementById('replay-play-btn')
    const speedBtn = document.getElementById('replay-speed-btn')
    const mapCanvas = document.getElementById('replay-map') as HTMLCanvasElement | null
    if (!slider || !playBtn) return

    const dur = enc.duration_secs || 1
    const timeline = enc.replay_timeline || []
    const bossHpTimeline = enc.boss_hp_timeline || []
    const bossPos = (enc as any).boss_positions || []

    // Build time index for fast lookup
    const timeIndex: { time: number; startIdx: number; endIdx: number }[] = []
    let idx = 0
    while (idx < timeline.length) {
        const t = timeline[idx].time
        const start = idx
        while (idx < timeline.length && timeline[idx].time === t) idx++
        timeIndex.push({ time: t, startIdx: start, endIdx: idx })
    }

    // Compute position bounding box for the map
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
    for (const s of timeline) {
        if (s.pos_x != null && s.pos_y != null) {
            const gx = s.pos_y, gy = -s.pos_x
            if (gx < minX) minX = gx; if (gx > maxX) maxX = gx
            if (gy < minY) minY = gy; if (gy > maxY) maxY = gy
        }
    }
    for (const bp of bossPos) {
        const bgx = bp[2], bgy = -bp[1]
        if (bgx < minX) minX = bgx; if (bgx > maxX) maxX = bgx
        if (bgy < minY) minY = bgy; if (bgy > maxY) maxY = bgy
    }
    const hasPositions = minX < Infinity
    const pad = 25

    // Auto-size canvas
    let mapW = 320, mapH = 320
    if (mapCanvas) {
        const containerW = mapCanvas.parentElement?.clientWidth ? mapCanvas.parentElement.clientWidth - 24 : 320
        const sz = Math.max(containerW, 200)
        mapCanvas.width = sz; mapCanvas.height = sz; mapW = sz; mapH = sz
    }

    const rangeX = (maxX - minX) || 1, rangeY = (maxY - minY) || 1
    const scale = Math.min((mapW - pad * 2) / rangeX, (mapH - pad * 2) / rangeY)
    const offsetX = (mapW - rangeX * scale) / 2, offsetY = (mapH - rangeY * scale) / 2

    let playing = false
    let animFrame: number | null = null
    let lastFrameTime = 0
    const speeds = [0.5, 1, 2, 4, 8]
    let speedIdx = 1

    const fmtTime = (s: number) => { const m = Math.floor(s / 60); const sec = Math.floor(s % 60); return m + ':' + (sec < 10 ? '0' : '') + sec }

    function findSnapshotsAtTime(t: number) {
        let lo = 0, hi = timeIndex.length - 1, best = -1
        while (lo <= hi) {
            const mid = (lo + hi) >> 1
            if (timeIndex[mid].time <= t) { best = mid; lo = mid + 1 } else hi = mid - 1
        }
        if (best < 0) return []
        return timeline.slice(timeIndex[best].startIdx, timeIndex[best].endIdx)
    }

    function findBossHpAtTime(t: number): number {
        let lo = 0, hi = bossHpTimeline.length - 1, best = -1
        while (lo <= hi) {
            const mid = (lo + hi) >> 1
            if (bossHpTimeline[mid][0] <= t) { best = mid; lo = mid + 1 } else hi = mid - 1
        }
        return best >= 0 ? bossHpTimeline[best][1] : 100
    }

    function updateDisplay(timeVal: number) {
        const t = timeVal / 10
        if (timeDisplay) timeDisplay.textContent = `${fmtTime(t)} / ${fmtTime(dur)}`

        const snapshots = findSnapshotsAtTime(t)

        // Update raid frames
        for (const s of snapshots) {
            const safeId = s.guid.replace(/[^a-zA-Z0-9]/g, '_')
            const frame = document.getElementById('rf-' + safeId)
            const fill = document.getElementById('rf-fill-' + safeId)
            const deficit = document.getElementById('rf-def-' + safeId)
            const hpText = document.getElementById('rf-hp-' + safeId)
            if (!frame) continue

            const pct = s.max_hp > 0 ? (s.current_hp / s.max_hp * 100) : 0
            if (s.is_dead) {
                frame.classList.add('dead')
                if (fill) fill.style.width = '0%'
                if (deficit) deficit.style.width = '100%'
                if (hpText) hpText.textContent = '💀 Dead'
            } else {
                frame.classList.remove('dead')
                if (fill) fill.style.width = pct.toFixed(1) + '%'
                if (deficit) deficit.style.width = (100 - pct).toFixed(1) + '%'
                if (hpText) hpText.textContent = formatNumber(s.current_hp)
            }
        }

        // Update boss HP
        const bossFill = document.getElementById('replay-boss-fill')
        const bossText = document.getElementById('replay-boss-text')
        if (bossFill && bossText) {
            const hp = findBossHpAtTime(t)
            bossFill.style.width = hp.toFixed(1) + '%'
            bossText.textContent = hp.toFixed(1) + '%'
        }

        // Draw position map
        if (mapCanvas && hasPositions && snapshots.length > 0) {
            const ctx = mapCanvas.getContext('2d')
            if (!ctx) return
            ctx.clearRect(0, 0, mapW, mapH)

            // Draw grid
            ctx.strokeStyle = 'rgba(255,255,255,0.05)'
            ctx.lineWidth = 1
            for (let gx = 0; gx <= mapW; gx += 40) { ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, mapH); ctx.stroke() }
            for (let gy = 0; gy <= mapH; gy += 40) { ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(mapW, gy); ctx.stroke() }

            // Find next time bucket for interpolation
            let lo2 = 0, hi2 = timeIndex.length - 1, bestCur = -1
            while (lo2 <= hi2) {
                const mid = (lo2 + hi2) >> 1
                if (timeIndex[mid].time <= t) { bestCur = mid; lo2 = mid + 1 } else hi2 = mid - 1
            }
            const nextIdx2 = bestCur + 1
            const hasNext = nextIdx2 < timeIndex.length
            const nextSnapshots = hasNext ? timeline.slice(timeIndex[nextIdx2].startIdx, timeIndex[nextIdx2].endIdx) : []
            const nextByGuid: Record<string, typeof timeline[0]> = {}
            for (const ns of nextSnapshots) nextByGuid[ns.guid] = ns
            const curTime = bestCur >= 0 ? timeIndex[bestCur].time : 0
            const nextTime = hasNext ? timeIndex[nextIdx2].time : curTime + 0.5
            const lerpFactor = (nextTime > curTime) ? Math.min(1, Math.max(0, (t - curTime) / (nextTime - curTime))) : 0

            // Draw player dots with interpolated positions
            ctx.font = '10px Inter, sans-serif'
            ctx.textAlign = 'center'
            for (const s of snapshots) {
                if (s.pos_x == null || s.pos_y == null) continue
                let gx = s.pos_y, gy = -s.pos_x
                const ns = nextByGuid[s.guid]
                if (ns && ns.pos_x != null && ns.pos_y != null) {
                    const ngx = ns.pos_y, ngy = -ns.pos_x
                    gx += (ngx - gx) * lerpFactor; gy += (ngy - gy) * lerpFactor
                }
                const cx = offsetX + (gx - minX) * scale, cy = offsetY + (gy - minY) * scale
                const color = classColor(s.class_name)

                if (s.is_dead) {
                    ctx.strokeStyle = '#666'; ctx.lineWidth = 2
                    ctx.beginPath(); ctx.moveTo(cx - 4, cy - 4); ctx.lineTo(cx + 4, cy + 4); ctx.stroke()
                    ctx.beginPath(); ctx.moveTo(cx + 4, cy - 4); ctx.lineTo(cx - 4, cy + 4); ctx.stroke()
                } else {
                    ctx.beginPath(); ctx.arc(cx, cy, 6, 0, Math.PI * 2)
                    ctx.fillStyle = color; ctx.fill()
                    ctx.strokeStyle = 'rgba(0,0,0,0.4)'; ctx.lineWidth = 1; ctx.stroke()
                    if (s.max_hp > 0) {
                        const hpPct = s.current_hp / s.max_hp
                        if (hpPct < 1) {
                            ctx.beginPath(); ctx.arc(cx, cy, 8, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * hpPct)
                            ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.stroke()
                        }
                    }
                }
                ctx.fillStyle = s.is_dead ? '#666' : 'rgba(255,255,255,0.8)'
                ctx.fillText(s.name.split('-')[0], cx, cy - 12)
            }

            // Draw boss marker (red diamond)
            if (bossPos.length > 0) {
                let bLo = 0, bHi = bossPos.length - 1, bBest = -1
                while (bLo <= bHi) {
                    const mid = (bLo + bHi) >> 1
                    if (bossPos[mid][0] <= t) { bBest = mid; bLo = mid + 1 } else bHi = mid - 1
                }
                if (bBest >= 0) {
                    let bgx = bossPos[bBest][2], bgy = -bossPos[bBest][1]
                    if (bBest + 1 < bossPos.length) {
                        const curBT = bossPos[bBest][0], nextBT = bossPos[bBest + 1][0]
                        const f = (nextBT > curBT) ? Math.min(1, (t - curBT) / (nextBT - curBT)) : 0
                        bgx += (bossPos[bBest + 1][2] - bgx) * f; bgy += (-bossPos[bBest + 1][1] - bgy) * f
                    }
                    const bcx = offsetX + (bgx - minX) * scale, bcy = offsetY + (bgy - minY) * scale
                    const ds = 10
                    ctx.beginPath(); ctx.moveTo(bcx, bcy - ds); ctx.lineTo(bcx + ds, bcy)
                    ctx.lineTo(bcx, bcy + ds); ctx.lineTo(bcx - ds, bcy); ctx.closePath()
                    ctx.fillStyle = '#ef4444'; ctx.fill()
                    ctx.strokeStyle = '#000'; ctx.lineWidth = 1.5; ctx.stroke()
                    ctx.font = 'bold 11px Inter, sans-serif'; ctx.fillStyle = '#ef4444'
                    ctx.fillText(enc.name || 'Boss', bcx, bcy - 14)
                }
            }
        }
    }

    slider.addEventListener('input', () => updateDisplay(parseInt(slider.value)))

    playBtn.addEventListener('click', () => {
        playing = !playing
        playBtn.textContent = playing ? '⏸' : '▶'
        if (playing) { lastFrameTime = performance.now(); animate() }
        else if (animFrame) { cancelAnimationFrame(animFrame); animFrame = null }
    })

    speedBtn?.addEventListener('click', () => {
        speedIdx = (speedIdx + 1) % speeds.length
        speedBtn.textContent = speeds[speedIdx] + '×'
    })

    let accumulator = 0
    function animate() {
        if (!playing) return
        const now = performance.now()
        const dt = (now - lastFrameTime) / 1000
        lastFrameTime = now
        accumulator += dt * speeds[speedIdx] * 10
        const advance = Math.floor(accumulator)
        if (advance > 0) {
            accumulator -= advance
            let val = parseInt(slider.value) + advance
            const maxVal = parseInt(slider.max)
            if (val >= maxVal) { val = maxVal; playing = false; playBtn!.textContent = '▶' }
            slider.value = String(val)
            updateDisplay(val)
        }
        if (playing) animFrame = requestAnimationFrame(animate)
    }

    // Store cleanup for this replay instance
    ; (window as any).__replayCleanup = () => {
        playing = false
        if (animFrame) { cancelAnimationFrame(animFrame); animFrame = null }
    }

    // Initial display
    updateDisplay(0)
}

// ========== Encounter pills builder ==========

function buildEncounterPills(summary: CombatLogSummary, currentEnc: EncounterSummary, currentIndex: number): string {
    if (currentEnc.encounter_type === 'mythic_plus') return ''
    const allRaid = summary.encounters.filter(e => e.encounter_type !== 'mythic_plus')
    if (allRaid.length <= 1) return ''

    const zc = (summary.zone_changes || []).slice().sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
    function zoneFor(e: EncounterSummary) {
        let zone = ''
        const t = new Date(e.start_time)
        for (const z of zc) { if (new Date(z.timestamp) <= t) zone = z.zone_name; else break }
        return zone
    }

    // Sessions
    const sessions: EncounterSummary[][] = []
    let cur = [allRaid[0]]
    for (let i = 1; i < allRaid.length; i++) {
        const prev = allRaid[i - 1], c = allRaid[i]
        const gap = (new Date(c.start_time).getTime() - new Date(prev.end_time || prev.start_time).getTime()) / 60000
        if (gap > 30 || c.difficulty_id !== prev.difficulty_id || zoneFor(c) !== zoneFor(prev)) {
            sessions.push(cur); cur = [c]
        } else cur.push(c)
    }
    sessions.push(cur)

    const mySession = sessions.find(s => s.some(e => e.index === currentIndex))
    if (!mySession || mySession.length <= 1) return ''

    // Build boss groups with preceding trash tied to each boss
    interface BossGroup { name: string; pulls: EncounterSummary[]; trash: EncounterSummary[] }
    const bossGroups: BossGroup[] = []
    const bossMap: Record<string, BossGroup> = {}
    let pendingTrash: EncounterSummary[] = []

    mySession.forEach(e => {
        if (e.encounter_type === 'trash') {
            pendingTrash.push(e)
        } else {
            if (!bossMap[e.name]) {
                const g: BossGroup = { name: e.name, pulls: [], trash: [...pendingTrash] }
                bossMap[e.name] = g
                bossGroups.push(g)
                pendingTrash = []
            }
            bossMap[e.name].pulls.push(e)
        }
    })
    // Trailing trash after last boss — attach to last boss
    if (pendingTrash.length > 0 && bossGroups.length > 0) {
        bossGroups[bossGroups.length - 1].trash.push(...pendingTrash)
    }
    if (bossGroups.length === 0) return ''

    // Find current boss
    const activeEnc = mySession.find(e => e.index === currentIndex)
    // If viewing trash, find which boss group owns it
    let currentBossName: string | null = null
    if (activeEnc) {
        if (activeEnc.encounter_type !== 'trash') {
            currentBossName = activeEnc.name
        } else {
            // Find the boss group that contains this trash encounter
            for (const g of bossGroups) {
                if (g.trash.some(t => t.index === currentIndex)) {
                    currentBossName = g.name; break
                }
            }
        }
    }
    const currentGroup = currentBossName ? bossMap[currentBossName] : null

    // --- TOP ROW: Boss-only pills ---
    const bossBar = bossGroups.map(g => {
        const isCurrent = currentBossName === g.name
        const killed = g.pulls.some(p => p.success)
        const abbr = g.name.length > 18 ? g.name.substring(0, 16) + '..' : g.name
        const borderCol = isCurrent ? (killed ? 'var(--accent-green)' : 'var(--accent-red)') : 'var(--border-color)'
        const bgCol = isCurrent ? (killed ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.15)') : 'var(--bg-card)'
        const textCol = isCurrent ? 'var(--text-primary)' : (killed ? 'var(--accent-green)' : 'var(--accent-red)')
        const killPull = g.pulls.find(p => p.success) || g.pulls[0]
        const pullCount = g.pulls.length
        const subLine = `${pullCount} pull${pullCount > 1 ? 's' : ''}`
        return `<div data-enc-index="${killPull.index}" style="flex:1;padding:6px 12px;border-radius:6px;cursor:pointer;border:1px solid ${borderCol};background:${bgCol};transition:all 0.15s;white-space:nowrap;text-align:center;color:${textCol};font-weight:${isCurrent ? '600' : '400'}">
            <div style="font-size:12px;line-height:1.3">${abbr}</div>
            <div style="font-size:10px;opacity:0.7;line-height:1.3">${subLine}</div>
        </div>`
    }).join('')

    // --- BOTTOM ROW: Trash + Pulls for current boss ---
    let subBar = ''
    if (currentGroup) {
        const items: string[] = []
        // Trash segments before boss
        currentGroup.trash.forEach((t, i) => {
            const isActive = t.index === currentIndex
            const label = currentGroup.trash.length > 1 ? `Trash ${i + 1}` : 'Trash'
            items.push(`<div data-enc-index="${t.index}" style="flex:0 0 auto;padding:5px 10px;border-radius:4px;cursor:pointer;border:1px solid ${isActive ? 'var(--text-muted)' : 'var(--border-color)'};background:${isActive ? 'rgba(100,100,100,0.2)' : 'var(--bg-secondary)'};transition:all 0.15s;text-align:center;font-size:11px;color:${isActive ? 'var(--text-primary)' : 'var(--text-muted)'};font-weight:${isActive ? '600' : '400'}">🗑️ ${label}</div>`)
        })
        // Boss pulls
        currentGroup.pulls.forEach((p, i) => {
            const isActive = p.index === currentIndex
            const col = p.success ? 'var(--accent-green)' : 'var(--accent-red)'
            const bg = isActive ? (p.success ? 'rgba(34,197,94,0.25)' : 'rgba(239,68,68,0.25)') : 'var(--bg-secondary)'
            const border = isActive ? col : 'var(--border-color)'
            const hp = p.boss_hp_pct
            const hpStr = hp !== null && hp !== undefined ? (hp === 0 ? ' · 0%' : ` · ${hp.toFixed(1)}%`) : ''
            items.push(`<div data-enc-index="${p.index}" style="flex:1;padding:5px 8px;border-radius:4px;cursor:pointer;border:1px solid ${border};background:${bg};transition:all 0.15s;text-align:center;font-size:11px;font-weight:600;color:${isActive ? col : 'var(--text-secondary)'};position:relative;overflow:hidden">
                <span style="position:relative;z-index:1">${i + 1}${hpStr}</span>
                <div style="position:absolute;bottom:0;left:0;width:100%;height:3px;background:${col};opacity:${p.success ? '1' : '0.5'}"></div>
            </div>`)
        })
        subBar = items.join('')
    }

    return `<div style="display:flex;flex-direction:column;gap:4px;min-width:max-content">
    <div style="display:flex;gap:3px;padding:4px 0">${bossBar}</div>
    ${subBar ? `<div style="display:flex;gap:3px">${subBar}</div>` : ''}
  </div>`
}
