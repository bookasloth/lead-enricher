# Watchdog: keep the Lead Enricher server alive and auto-resume running jobs after a crash.
# Stop it by creating a file named  watchdog.stop  in this folder (or closing the window).
# ponytail: 30s poll + "resume up to 2 newest jobs still marked running" — fine for a single-box dev tool.

Set-Location -Path $PSScriptRoot
$port = 5178
$base = "http://localhost:$port"

function Server-Up {
  try { Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop | Out-Null; return $true }
  catch { return $false }
}

Write-Host "[watchdog] watching $base - create 'watchdog.stop' to end"
while (-not (Test-Path "watchdog.stop")) {
  if (-not (Server-Up)) {
    Write-Host "[watchdog] $(Get-Date -Format HH:mm:ss) server down - restarting"
    $ids = docker ps -q --filter "name=gmaps-"
    if ($ids) { foreach ($c in $ids) { docker kill $c | Out-Null } }
    Start-Process -FilePath "node" -ArgumentList "server.mjs" -RedirectStandardOutput "server-night.log" -RedirectStandardError "server-night.err" -WindowStyle Hidden
    Start-Sleep -Seconds 5
    try {
      $resp = Invoke-RestMethod -Uri "$base/api/gmaps/jobs" -TimeoutSec 5
      $running = @($resp.jobs | Where-Object { $_.status -eq "running" } | Sort-Object id -Descending | Select-Object -First 2)
      foreach ($j in $running) {
        Invoke-RestMethod -Method Post -Uri "$base/api/gmaps/jobs/$($j.id)/start" -TimeoutSec 5 | Out-Null
        Write-Host "[watchdog] resumed job $($j.id)"
      }
    }
    catch { Write-Host "[watchdog] resume probe failed: $_" }
  }
  Start-Sleep -Seconds 30
}
Remove-Item "watchdog.stop" -ErrorAction SilentlyContinue
Write-Host "[watchdog] stopped"
