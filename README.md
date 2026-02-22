<p align="center">
  <img src="assets/logo.png" width="400" alt="Fast WoW Combat Analyser" />
</p>

<h1 align="center">Fast WoW Combat Analyser</h1>

<p align="center">
  <strong>Instant, offline combat log analysis for World of Warcraft</strong><br />
  No uploads. No delays. Just open and analyze.
</p>

---

## Why?

Since the **WoW Midnight** release, the popular **Details! Damage Meter** addon has struggled to provide reliable post-combat analytics. Encounter breakdowns, damage/healing meters, and timeline data are often inaccurate or missing entirely — leaving raiders and M+ pushers without the tools they need to improve.

Existing alternatives like Warcraftlogs require **uploading** your combat logs to an external server and waiting for them to be processed. That's fine for progression review, but when you just want to quickly check how a pull went between attempts, that workflow is too slow.

**Fast WoW Combat Analyser** fills that gap. It reads your `WoWCombatLog` files **directly from disk** and presents a full analysis **instantly** in your browser — no uploads, no accounts, no waiting.

---

## Features

- ⚡ **Instant analysis** — parses even 500MB+ logs in seconds
- 🏰 **Raid support** — boss encounters grouped by instance, kill/wipe tracking, damage & healing meters with boss HP timelines
- 🗝️ **Mythic+ support** — key level, timer, timed/depleted status, segment-by-segment breakdown (trash vs bosses)
- 📊 **Detailed meters** — DPS, HPS, damage taken, deaths, and more per encounter
- 💀 **Death log** — see exactly what killed each player
- 🔄 **Live refresh** — re-read the log file mid-session to see the latest data
- 🎨 **Dark theme** — easy on the eyes during late-night prog
- 📦 **Single portable .exe** — no installation, no dependencies, just run it

---

## Demo

![Fast WoW Combat Analyser in action](screenshots/Animation.gif)

---

## Getting Started

### Download
Grab the latest `wowlogger.exe` from the [Releases](https://github.com/D4GGe/Fast-WoW-Combat-analyser/releases) page.

### Run
1. Double-click `wowlogger.exe`
2. It auto-detects your WoW combat log directory (`World of Warcraft\_retail_\Logs`)
3. Click **"Open in Browser"** — your analysis is ready at `http://localhost:3000`

> ⚠️ **Windows SmartScreen** may block the program on first launch because the executable is not code-signed. Click **"More info"** → **"Run anyway"** to proceed. The app is fully open-source — feel free to inspect or build it yourself.

### Make sure combat logging is enabled
Type `/combatlog` in WoW to start recording, or add this to your WoW macros to toggle it automatically.

---

## Building from Source

```bash
# Clone
git clone https://github.com/D4GGe/Fast-WoW-Combat-analyser.git
cd Fast-WoW-Combat-analyser

# Build (requires Rust toolchain)
cargo build --release

# The binary is at target/release/wowlogger.exe
```

---

## Tech Stack

- **Backend**: Rust (Tokio + Axum) — fast, safe, and memory-efficient
- **Frontend**: Vanilla HTML/CSS/JS — embedded directly in the binary
- **GUI**: Native Win32 — lightweight control window with dark theme
- **No external dependencies at runtime** — everything is compiled into a single executable

---

<p align="center">
  Made with ♥ by D4GGe
</p>
