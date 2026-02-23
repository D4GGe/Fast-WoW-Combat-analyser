// Utility functions ported from inline JS

export function formatNumber(n: number): string {
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return String(Math.round(n));
}

export function formatDuration(secs: number): string {
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
}

const CLASS_COLORS: Record<string, string> = {
    'Warrior': '#C79C6E',
    'Paladin': '#F58CBA',
    'Hunter': '#ABD473',
    'Rogue': '#FFF569',
    'Priest': '#FFFFFF',
    'Death Knight': '#C41F3B',
    'Shaman': '#0070DE',
    'Mage': '#69CCF0',
    'Warlock': '#9482C9',
    'Monk': '#00FF96',
    'Druid': '#FF7D0A',
    'Demon Hunter': '#A330C9',
    'Evoker': '#33937F',
};

export function classColor(className: string): string {
    return CLASS_COLORS[className] || 'var(--text-primary)';
}

export function roleIcon(role: string): { icon: string; label: string } {
    if (role === 'tank') return { icon: '🛡️', label: 'Tank' };
    if (role === 'healer') return { icon: '💚', label: 'Healer' };
    return { icon: '⚔️', label: 'DPS' };
}

const SCHOOL_COLORS: Record<number, string> = {
    1: '#FFD100', // Physical
    2: '#FFE680', // Holy
    4: '#FF8000', // Fire
    8: '#4DFF4D', // Nature
    16: '#6699FF', // Frost
    32: '#9933FF', // Shadow
    64: '#FF4DFF', // Arcane
};

export function getSchoolColor(school: number): string {
    if (SCHOOL_COLORS[school]) return SCHOOL_COLORS[school];
    // Multi-school — find the first matching bit
    for (const [bit, color] of Object.entries(SCHOOL_COLORS)) {
        if (school & Number(bit)) return color;
    }
    return 'var(--text-secondary)';
}
