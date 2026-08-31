$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw 'Node.js is not installed. Install Node.js 22 from https://nodejs.org and re-run this script.'
}

Write-Host 'Installing dependencies, database, and starting the API...'
npm run setup:dev
exit $LASTEXITCODE
