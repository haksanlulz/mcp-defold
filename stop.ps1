# stop.ps1 -- force-stop the Defold engine listening on a bridge port, by PID.
# Used by defold_stop {force:true} when the bridge no longer answers `quit`.
# Refuses anything that is not a Defold engine (dmengine*), so a port taken
# by another program is never killed. Prints `KILLED <pid> <name>` or
# `FAIL: <reason>` and exits 1.
param([Parameter(Mandatory)][int]$Port)
$ErrorActionPreference = 'Stop'
try {
  $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop | Select-Object -First 1
} catch {
  Write-Output "FAIL: nothing is listening on port $Port"
  exit 1
}
$procId = [int]$conn.OwningProcess
$proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
if (-not $proc) { Write-Output "FAIL: process $procId on port $Port is gone"; exit 1 }
if ($proc.ProcessName -notlike 'dmengine*') {
  Write-Output "FAIL: process $procId on port $Port is $($proc.ProcessName), not a Defold engine; not killing it"
  exit 1
}
& taskkill /PID $procId /T /F | Out-Null
for ($i = 0; $i -lt 50; $i++) {
  if (-not (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)) {
    Write-Output "KILLED $procId $($proc.ProcessName)"
    exit 0
  }
  Start-Sleep -Milliseconds 100
}
Write-Output "FAIL: killed $procId but port $Port is still held"
exit 1
