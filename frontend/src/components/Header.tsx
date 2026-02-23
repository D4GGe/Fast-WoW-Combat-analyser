import { useState, useEffect } from 'react'
import { useLocation, Link } from 'react-router-dom'

export default function Header() {
    const location = useLocation()
    const isHome = location.pathname === '/' || location.pathname === ''
    const parts = location.pathname.split('/').filter(Boolean)

    // Parse breadcrumb from URL: /log/:filename/encounter/:index
    const filename = parts[1] ? decodeURIComponent(parts[1]) : null
    const encIndex = parts[3] ? parts[3] : null

    // Listen for encounter name changes from EncounterDetail
    const [encName, setEncName] = useState<string | null>((window as any).__encName || null)
    useEffect(() => {
        const handler = () => setEncName((window as any).__encName || null)
        window.addEventListener('encNameChanged', handler)
        // Also re-check on location change
        handler()
        return () => window.removeEventListener('encNameChanged', handler)
    }, [location.pathname])

    return (
        <header className="header">
            <div className="header-inner">
                <Link to="/" className="logo" style={{ textDecoration: 'none' }}>
                    {!isHome && (
                        <img src="/favicon.png" alt="" style={{ width: 28, height: 28, borderRadius: 6, objectFit: 'cover' }} />
                    )}
                    <span>Fast WoW Combat Analyzer</span>
                </Link>
                <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                    {filename && (
                        <div className="breadcrumb">
                            <Link to="/">Log Files</Link>
                            <span className="sep">›</span>
                            {encIndex ? (
                                <>
                                    <Link to={`/log/${encodeURIComponent(filename)}`}>{filename}</Link>
                                    <span className="sep">›</span>
                                    <span className="current">{encName || `Encounter ${encIndex}`}</span>
                                </>
                            ) : (
                                <span className="current">{filename}</span>
                            )}
                        </div>
                    )}
                    {filename && (
                        <button
                            className="back-btn"
                            style={{ marginBottom: 0, fontSize: 12, padding: '4px 12px' }}
                            onClick={() => window.location.reload()}
                        >
                            🔄 Refresh
                        </button>
                    )}
                </div>
            </div>
        </header>
    )
}
