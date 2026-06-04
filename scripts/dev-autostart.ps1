# Auto-start the AI-STARTUP dev stack (API :4000 + Web :3000).
#
# Invoked at logon by the "AI-STARTUP Dev Stack" HKCU Run entry, but also safe
# to run by hand. Idempotent and per-port guarded: it only starts a server
# whose port is currently free, so it never conflicts with an instance you
# already have running. Each server is launched hidden + detached from its own
# workspace directory (the proven pattern: running "npm run dev" from the app
# dir, NOT "-w" from the repo root), with its own log file.
#
# NOTE: keep this file ASCII-only. Windows PowerShell 5.1 reads .ps1 as ANSI
# when there is no BOM, so non-ASCII characters (em dashes, etc.) corrupt it.
$ErrorActionPreference = 'SilentlyContinue'

$repo = "C:\Users\SIVAGURU R.M\OneDrive\Desktop\AI STARTUP"
$logFile = Join-Path $repo "apps\api\.dev-autostart.log"

function Write-Log([string]$msg) {
  "[{0}] {1}" -f (Get-Date -Format s), $msg | Out-File -Append -Encoding utf8 $logFile
}

function Test-PortListening([int]$port) {
  $conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
  return (($conns | Measure-Object).Count -gt 0)
}

function Start-DevServer([string]$name, [int]$port, [string]$workdir, [string]$outLog, [string]$errLog) {
  if (Test-PortListening $port) {
    Write-Log ("{0} already listening on :{1} - skip" -f $name, $port)
    return
  }
  Write-Log ("starting {0} (npm run dev in {1})" -f $name, $workdir)
  Start-Process -FilePath "npm.cmd" -ArgumentList "run", "dev" `
    -WorkingDirectory $workdir -WindowStyle Hidden `
    -RedirectStandardOutput $outLog -RedirectStandardError $errLog
}

Write-Log "dev-autostart invoked"
Start-DevServer "API" 4000 (Join-Path $repo "apps\api") `
  (Join-Path $repo "apps\api\.dev-autostart.api.out.log") `
  (Join-Path $repo "apps\api\.dev-autostart.api.err.log")
Start-DevServer "Web" 3000 (Join-Path $repo "apps\web") `
  (Join-Path $repo "apps\web\.dev-autostart.web.out.log") `
  (Join-Path $repo "apps\web\.dev-autostart.web.err.log")
Write-Log "dev-autostart done"
