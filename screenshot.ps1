# screenshot.ps1 -- capture the window of the process listening on a bridge
# port, without bringing it to the front (PrintWindow, PW_RENDERFULLCONTENT).
# Used by defold_screenshot. Prints `SHOT <path> <w>x<h>` on success, or
# `FAIL: <reason>` and exits 1.
param([Parameter(Mandatory)][int]$Port, [Parameter(Mandatory)][string]$Out)
$ErrorActionPreference = 'Stop'
try {
  $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop | Select-Object -First 1
} catch {
  Write-Output "FAIL: nothing is listening on port $Port (is the game running? use defold_run)"
  exit 1
}
$proc = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
if (-not $proc -or $proc.MainWindowHandle -eq [IntPtr]::Zero) {
  Write-Output "FAIL: process $($conn.OwningProcess) on port $Port has no window to capture"
  exit 1
}
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class McpDefoldShot {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint f);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
"@
[McpDefoldShot]::SetProcessDPIAware() | Out-Null
$h = $proc.MainWindowHandle
$r = New-Object McpDefoldShot+RECT
[McpDefoldShot]::GetWindowRect($h, [ref]$r) | Out-Null
$w = $r.R - $r.L; $ht = $r.B - $r.T
if ($w -le 0 -or $ht -le 0) { Write-Output "FAIL: the window is minimized (size ${w}x${ht})"; exit 1 }
$bmp = New-Object System.Drawing.Bitmap $w, $ht
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
$ok = [McpDefoldShot]::PrintWindow($h, $hdc, 2)
$g.ReleaseHdc($hdc); $g.Dispose()
if (-not $ok) { $bmp.Dispose(); Write-Output "FAIL: PrintWindow refused the window"; exit 1 }
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Out) | Out-Null
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
Write-Output "SHOT $Out ${w}x${ht}"
