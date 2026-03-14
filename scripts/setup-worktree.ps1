#!/usr/bin/env pwsh
# scripts/setup-worktree.ps1 — Pre-warm a worktree for parallel development
# Usage: .\scripts\setup-worktree.ps1 -WorktreePath C:\repos\myelin-cajal1

param(
    [Parameter(Mandatory=$true)]
    [string]$WorktreePath,

    [string]$MainRepo = "C:\repos\myelin"
)

$ErrorActionPreference = "Stop"

Write-Host "`n=== Worktree Setup: $WorktreePath ===" -ForegroundColor Cyan

# 1. Verify the worktree exists
if (-not (Test-Path "$WorktreePath\.git")) {
    Write-Host "❌ Not a valid worktree: $WorktreePath" -ForegroundColor Red
    exit 1
}
Write-Host "✅ Worktree exists"

# 2. Create node_modules junction
$nmPath = Join-Path $WorktreePath "node_modules"
$nmTarget = Join-Path $MainRepo "node_modules"

if (-not (Test-Path $nmTarget)) {
    Write-Host "❌ Main repo node_modules missing: $nmTarget" -ForegroundColor Red
    Write-Host "   Run 'npm install --legacy-peer-deps' in $MainRepo first."
    exit 1
}

# Remove existing (broken junction or real directory)
if (Test-Path $nmPath) {
    $item = Get-Item $nmPath -Force
    $isJunction = ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0
    if ($isJunction) {
        Write-Host "⏭️  Junction already exists"
    } else {
        Write-Host "⚠️  Removing non-junction node_modules..."
        Remove-Item $nmPath -Recurse -Force
        New-Item -ItemType Junction -Path $nmPath -Target $nmTarget | Out-Null
        Write-Host "✅ Junction recreated"
    }
} else {
    New-Item -ItemType Junction -Path $nmPath -Target $nmTarget | Out-Null
    Write-Host "✅ Junction created"
}

# 3. Verify native modules load
Write-Host "Verifying native modules..." -NoNewline
$checkScript = @"
try { require('better-sqlite3'); process.stdout.write(' sqlite3'); } catch(e) { process.stdout.write(' ❌sqlite3'); process.exitCode=1; }
try { require('tree-sitter'); process.stdout.write(' tree-sitter'); } catch(e) { process.stdout.write(' ⚠️tree-sitter(optional)'); }
"@

Push-Location $WorktreePath
$result = node -e $checkScript 2>&1
Pop-Location
Write-Host " $result"

# 4. Verify TypeScript
$tscPath = Join-Path $nmPath "typescript\bin\tsc"
if (Test-Path $tscPath) {
    Write-Host "✅ TypeScript available"
} else {
    Write-Host "⚠️  TypeScript not found — run 'npm install --ignore-scripts typescript' in main repo"
}

Write-Host "`n✅ Worktree ready: $WorktreePath" -ForegroundColor Green
Write-Host "   Branch: $(git -C $WorktreePath branch --show-current)"
Write-Host "   Test:   npx vitest run --exclude tests/code/parsers.test.ts --exclude tests/code/walker.test.ts"
Write-Host "   Build:  node node_modules\typescript\bin\tsc --noEmit"
