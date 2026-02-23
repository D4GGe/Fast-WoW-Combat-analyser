import { useEffect, useRef, useCallback } from 'react'
import { useSpellTooltips } from '../hooks/useSpellTooltips'

/** Global floating spell tooltip — mounts once at app root */
export default function SpellTooltipGlobal() {
    const tipRef = useRef<HTMLDivElement>(null)
    const activeWrapRef = useRef<Element | null>(null)
    const { getTooltip } = useSpellTooltips()

    const handleMouseOver = useCallback((e: MouseEvent) => {
        const wrap = (e.target as Element)?.closest('.spell-tooltip-wrap[data-spell-id]')
        if (!wrap || wrap === activeWrapRef.current) return
        activeWrapRef.current = wrap
        const tip = tipRef.current
        if (!tip) return

        const sid = Number(wrap.getAttribute('data-spell-id'))
        const sname = wrap.getAttribute('data-spell-name') || ''
        const tt = getTooltip(sid, sname)
        if (!tt || (!tt.name && !tt.description)) {
            tip.classList.remove('visible')
            return
        }
        tip.innerHTML = `<div class="spell-tooltip-name">${tt.icon_url ? `<img class="spell-tooltip-icon" src="${tt.icon_url}">` : ''}${tt.name || sname}</div>${tt.description ? `<div class="spell-tooltip-desc">${tt.description}</div>` : ''}`
        const rect = wrap.getBoundingClientRect()
        let top = rect.top - tip.offsetHeight - 8
        let left = rect.left
        if (top < 4) top = rect.bottom + 8
        if (left + 360 > window.innerWidth) left = window.innerWidth - 370
        if (left < 4) left = 4
        tip.style.top = top + 'px'
        tip.style.left = left + 'px'
        tip.classList.add('visible')
    }, [getTooltip])

    const handleMouseOut = useCallback((e: MouseEvent) => {
        const wrap = (e.target as Element)?.closest('.spell-tooltip-wrap[data-spell-id]')
        if (wrap && wrap === activeWrapRef.current) {
            if (!wrap.contains(e.relatedTarget as Node)) {
                activeWrapRef.current = null
                tipRef.current?.classList.remove('visible')
            }
        }
    }, [])

    useEffect(() => {
        document.addEventListener('mouseover', handleMouseOver as EventListener)
        document.addEventListener('mouseout', handleMouseOut as EventListener)
        return () => {
            document.removeEventListener('mouseover', handleMouseOver as EventListener)
            document.removeEventListener('mouseout', handleMouseOut as EventListener)
        }
    }, [handleMouseOver, handleMouseOut])

    return <div ref={tipRef} className="spell-tooltip" />
}

/** Render spell icon + name as an HTML string (for dangerouslySetInnerHTML contexts) */
export function spellHtml(
    spellId: number,
    spellName: string,
    wowheadUrl: string,
    getTooltip: (id: number, name?: string) => { icon_url?: string; name?: string; description?: string } | null,
    opts?: { color?: string; iconSize?: number; stopClick?: boolean }
): string {
    const tt = getTooltip(spellId, spellName) || {} as { icon_url?: string; name?: string; description?: string }
    const linkColor = opts?.color || 'var(--accent-gold)'
    const iconSize = opts?.iconSize || 18
    const iconHtml = tt.icon_url ? `<img class="spell-icon" src="${tt.icon_url}" alt="" loading="lazy" style="width:${iconSize}px;height:${iconSize}px">` : ''
    const nameHtml = wowheadUrl
        ? `<a href="${wowheadUrl}" target="_blank" style="color:${linkColor};text-decoration:none;font-weight:500" ${opts?.stopClick ? 'onclick="event.stopPropagation()"' : ''}>${spellName}</a>`
        : `<span style="color:${linkColor};font-weight:500">${spellName}</span>`
    const hasTooltip = tt.name || tt.description
    const dataAttr = hasTooltip ? ` data-spell-id="${spellId}" data-spell-name="${spellName}"` : ''
    return `<div class="spell-tooltip-wrap"${dataAttr}>${iconHtml}${nameHtml}</div>`
}
