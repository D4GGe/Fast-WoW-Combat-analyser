import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { fetchLogs } from '../api'
import type { LogFileInfo } from '../types'

export default function LogList() {
    const [logs, setLogs] = useState<LogFileInfo[]>([])
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
        fetchLogs()
            .then(data => { setLogs(data); setLoading(false) })
            .catch(e => { setError(e.message); setLoading(false) })
    }, [])

    if (loading) {
        return (
            <div className="loading">
                <div className="spinner" />
                <div className="loading-text">Loading log files...</div>
            </div>
        )
    }

    if (error) {
        return (
            <div className="empty-state">
                <div className="icon">❌</div>
                <div className="title">Error</div>
                <p>{error}</p>
            </div>
        )
    }

    if (logs.length === 0) {
        return (
            <div className="empty-state">
                <div className="icon">📂</div>
                <div className="title">No log files found</div>
                <p>Place WoW combat log files in your Logs directory and refresh.</p>
            </div>
        )
    }

    return (
        <>
            <div style={{ textAlign: 'center', padding: '30px 0 10px' }}>
                <img src="/logo.png" style={{ width: 512, maxWidth: '90%', height: 'auto', borderRadius: 12, objectFit: 'contain' }} alt="Fast WoW Combat Analyzer" />
            </div>
            <h1 className="page-title">Combat Log Files</h1>
            <p className="page-subtitle">{logs.length} log files found — click one to analyze</p>
            <div className="card-grid">
                {logs.map((log, i) => (
                    <Link
                        key={log.filename}
                        to={`/log/${encodeURIComponent(log.filename)}`}
                        className="card animate-in"
                        style={{ animationDelay: `${i * 30}ms`, textDecoration: 'none' }}
                    >
                        <div className="card-header">
                            <div className="card-title">📜 {log.date_str}</div>
                            <div className="card-badge">{log.size_display}</div>
                        </div>
                        <div className="card-meta">
                            <span>📄 {log.filename}</span>
                        </div>
                    </Link>
                ))}
            </div>
        </>
    )
}
