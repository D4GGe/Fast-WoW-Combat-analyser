---
description: How to create a new release of Fast WoW Combat Analyzer
---

# Release Workflow

// turbo-all

1. Make sure all changes are committed and pushed to `main`:
```powershell
git status
```

2. Run the release script from the project root:
```powershell
.\release.ps1
```

The script will automatically:
- Detect the latest git tag and bump the minor version (e.g., `0.1.1` → `0.2.0`)
- Update the version string in `Cargo.toml`, `src/gui.rs`, and `frontend/src/components/Footer.tsx`
- Build the release binary (which also builds the frontend via `build.rs`)
- Copy the binary as `FastWoWCombatAnalyzer.exe`
- Generate release notes from the git log since the last tag
- Commit the version bump, create a git tag, and push
- Create a **draft** GitHub release with the binary attached

3. Go to [GitHub Releases](https://github.com/D4GGe/Fast-WoW-Combat-analyser/releases) to review and edit the draft

4. When ready, click **Publish release** on GitHub

## Version Locations

The version string is stored in 3 places:
- `Cargo.toml` — `version = "x.y.z"`
- `src/gui.rs` — native window footer label
- `frontend/src/components/Footer.tsx` — web UI footer

The release script updates all three automatically.
