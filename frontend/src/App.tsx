import { Routes, Route } from 'react-router-dom'
import Header from './components/Header'
import Footer from './components/Footer'
import SpellTooltipGlobal from './components/SpellTooltip'
import LogList from './pages/LogList'
import EncounterList from './pages/EncounterList'
import EncounterDetail from './pages/EncounterDetail/EncounterDetail'

export default function App() {
    return (
        <>
            <Header />
            <div className="container" id="app">
                <Routes>
                    <Route path="/" element={<LogList />} />
                    <Route path="/log/:filename" element={<EncounterList />} />
                    <Route path="/log/:filename/encounter/:index" element={<EncounterDetail />} />
                </Routes>
            </div>
            <Footer />
            <SpellTooltipGlobal />
        </>
    )
}
