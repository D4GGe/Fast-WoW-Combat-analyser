# release.ps1 — Automated release workflow for Fast WoW Combat Analyzer
# Usage: .\release.ps1
# Creates a draft GitHub release with:
#   - Auto-incremented minor version
#   - Version updated in Cargo.toml, gui.rs, Footer.tsx
#   - AI-generated release title and notes from git diff
#   - Built binary attached as FastWoWCombatAnalyzer.exe

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# --- 1. Determine new version ---
$lastTag = git describe --tags --abbrev=0 2>$null
if (-not $lastTag) {
    Write-Host "No existing tags found. Starting at 0.1.0"
    $lastTag = "0.0.0"
}
Write-Host "Last tag: $lastTag"

# Parse version (strip leading 'v' if present)
$ver = $lastTag -replace '^v', ''
$parts = $ver.Split('.')
$major = [int]$parts[0]
$minor = [int]$parts[1]
$patch = [int]$parts[2]

# Bump minor version
$minor++
$patch = 0
$newVersion = "$major.$minor.$patch"
$newTag = "$newVersion"
Write-Host "New version: $newVersion (tag: $newTag)"

# --- 2. Update version in source files ---
Write-Host "`nUpdating version in source files..."

# Cargo.toml
$cargoToml = Get-Content "Cargo.toml" -Raw
$cargoToml = $cargoToml -replace 'version = "\d+\.\d+\.\d+"', "version = `"$newVersion`""
Set-Content "Cargo.toml" $cargoToml -NoNewline
Write-Host "  Updated Cargo.toml"

# gui.rs — native window footer
$guiRs = Get-Content "src\gui.rs" -Raw
$guiRs = $guiRs -replace 'v\d+\.\d+\.\d+', "v$newVersion"
Set-Content "src\gui.rs" $guiRs -NoNewline
Write-Host "  Updated src\gui.rs"

# Footer.tsx — web footer
$footer = Get-Content "frontend\src\components\Footer.tsx" -Raw
$footer = $footer -replace 'v\d+\.\d+\.\d+', "v$newVersion"
Set-Content "frontend\src\components\Footer.tsx" $footer -NoNewline
Write-Host "  Updated frontend\src\components\Footer.tsx"

# --- 3. Build release binary ---
Write-Host "`nBuilding release binary..."
taskkill /f /im wowlogger.exe 2>$null
Start-Sleep -Seconds 1

# Build frontend first to ensure version bump in Footer.tsx is included
Write-Host "  Building frontend..."
Push-Location frontend
npm run build
if ($LASTEXITCODE -ne 0) {
    Pop-Location
    Write-Error "Frontend build failed!"
    exit 1
}
Pop-Location
Write-Host "  Frontend built successfully"

# Build Rust binary (will embed the freshly-built frontend via rust-embed)
Write-Host "  Building Rust binary..."
cargo build --release --bin wowlogger
if ($LASTEXITCODE -ne 0) {
    Write-Error "Rust build failed!"
    exit 1
}

# Copy and rename binary
$binaryPath = "target\release\wowlogger.exe"
$releaseBinary = "FastWoWCombatAnalyzer.exe"
Copy-Item $binaryPath $releaseBinary -Force
$size = (Get-Item $releaseBinary).Length / 1MB
Write-Host "Built $releaseBinary ($([math]::Round($size, 1)) MB)"

# --- 4. Generate release notes with AI ---
Write-Host "`nGenerating release notes..."

# Get diff summary since last tag
$diffStat = git diff "$lastTag..HEAD" --stat 2>$null
$diffLog = git log "$lastTag..HEAD" --oneline --no-merges 2>$null

# Build the prompt for AI-generated notes
$prompt = @"
Generate a GitHub release title and release notes for version $newVersion of "Fast WoW Combat Analyzer" — a WoW combat log analyzer with a Rust backend and React frontend.

Here are the commits since the last release ($lastTag):
$diffLog

Here is the diff stat:
$diffStat

Instructions:
- First line should be just the release title (short, descriptive, no version prefix)
- Then a blank line
- Then markdown release notes with sections like ## What's New, ## Bug Fixes, ## Improvements
- Keep it concise and user-facing (not developer-facing)
- Use emoji sparingly for section headers
"@

# Try to use gh copilot for AI generation, fall back to commit log
$releaseTitle = "v$newVersion"
$releaseNotes = ""

try {
    # Use Gemini CLI or gh copilot if available
    $aiOutput = echo $prompt | gh copilot suggest --type text 2>$null
    if ($aiOutput -and $LASTEXITCODE -eq 0) {
        $lines = $aiOutput -split "`n"
        $releaseTitle = $lines[0].Trim()
        $releaseNotes = ($lines[2..($lines.Length - 1)] -join "`n").Trim()
    }
} catch {}

# Fallback: generate notes from commit log
if (-not $releaseNotes) {
    Write-Host "  AI generation unavailable, using commit log for notes"
    $releaseTitle = "v$newVersion"
    $noteLines = @("## What's Changed`n")
    foreach ($line in ($diffLog -split "`n")) {
        if ($line.Trim()) {
            $hash = $line.Substring(0, [Math]::Min(7, $line.Length))
            $msg = $line.Substring([Math]::Min(8, $line.Length)).Trim()
            $noteLines += "- $msg ($hash)"
        }
    }
    $noteLines += "`n**Full Changelog**: https://github.com/D4GGe/Fast-WoW-Combat-analyser/compare/$lastTag...$newTag"
    $releaseNotes = $noteLines -join "`n"
}

Write-Host "`nRelease title: $releaseTitle"
Write-Host "Release notes preview:"
Write-Host $releaseNotes

# --- 5. Commit version bump ---
Write-Host "`nCommitting version bump..."
git add Cargo.toml src/gui.rs frontend/src/components/Footer.tsx
git commit -m "chore: bump version to $newVersion"
git tag $newTag

# --- 6. Push and create draft release ---
Write-Host "`nPushing tag and creating draft release..."
git push origin main
git push origin $newTag

# Save release notes to temp file (gh has issues with multiline strings)
$notesFile = [System.IO.Path]::GetTempFileName()
Set-Content $notesFile $releaseNotes

gh release create $newTag `
    --title "$releaseTitle" `
    --notes-file $notesFile `
    --draft `
    "$releaseBinary"

Remove-Item $notesFile -ErrorAction SilentlyContinue

Write-Host "`n✅ Draft release $newTag created!"
Write-Host "   Edit at: https://github.com/D4GGe/Fast-WoW-Combat-analyser/releases"
Write-Host "   Don't forget to review and publish the draft!"
