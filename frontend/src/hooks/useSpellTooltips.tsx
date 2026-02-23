import { useState, useEffect, useCallback, createContext, useContext } from 'react';
import type { SpellTooltip } from '../types';
import { fetchSpellTooltips } from '../api';

interface SpellTooltipContext {
    getTooltip: (spellId: number, spellName?: string) => SpellTooltip | null;
    tooltips: Record<string, SpellTooltip>;
}

const TooltipContext = createContext<SpellTooltipContext>({
    getTooltip: () => null,
    tooltips: {},
});

export function SpellTooltipProvider({ children }: { children: React.ReactNode }) {
    const [tooltips, setTooltips] = useState<Record<string, SpellTooltip>>({});
    const [tooltipsByName, setTooltipsByName] = useState<Record<string, SpellTooltip>>({});

    useEffect(() => {
        fetchSpellTooltips().then(data => {
            setTooltips(data);
            const byName: Record<string, SpellTooltip> = {};
            for (const [, tt] of Object.entries(data)) {
                if (tt.name && (tt.icon_url || tt.description)) {
                    const key = tt.name.toLowerCase();
                    const existing = byName[key];
                    if (!existing || (!existing.icon_url && tt.icon_url) || (!existing.description && tt.description)) {
                        byName[key] = tt;
                    }
                }
            }
            setTooltipsByName(byName);
        });
    }, []);

    const getTooltip = useCallback((spellId: number, spellName?: string): SpellTooltip | null => {
        const byId = tooltips[String(spellId)];
        if (byId && (byId.icon_url || byId.description)) return byId;
        if (spellName) {
            const byName = tooltipsByName[spellName.toLowerCase()];
            if (byName) return byName;
        }
        return null;
    }, [tooltips, tooltipsByName]);

    return (
        <TooltipContext.Provider value={{ getTooltip, tooltips }}>
            {children}
        </TooltipContext.Provider>
    );
}

export function useSpellTooltips() {
    return useContext(TooltipContext);
}
