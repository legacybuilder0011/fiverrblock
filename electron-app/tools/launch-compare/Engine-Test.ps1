param([int]$WaitSeconds = 35, [string[]]$ExtraArguments = @(), [string]$ResultPath, [bool]$AppPreferences = $false)
$ErrorActionPreference = 'Stop'
$WaitSeconds = [Math]::Max(5, [Math]::Min(90, $WaitSeconds))
$report = [ordered]@{ diagnosticVersion = 1; timeUtc = [DateTime]::UtcNow.ToString('o') }
$desktop = [Environment]::GetFolderPath('Desktop')
if (-not $desktop -or -not (Test-Path -LiteralPath $desktop)) { $desktop = $env:TEMP }
$reportPath = $ResultPath
if (-not $reportPath) { throw 'ResultPath is required for the internal diagnostic runner.' }
$engine = Join-Path $env:APPDATA 'privacy-shield\fingerprint-chromium\ungoogled-chromium_148.0.7778.215-1.1_windows_x64\chrome.exe'
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('ps-support-' + [Guid]::NewGuid().ToString('N'))
$browser = $null
$testStart = $null
$owned = @{}
function SafeText([string]$value) {
  $value = $value -replace '(?i)[a-z]:\\[^\r\n]*', '[local path omitted]'
  $value = $value -replace '(?i)https?://\S+', '[URL omitted]'
  $value = $value -replace '\b(?:\d{1,3}\.){3}\d{1,3}\b', '[IP omitted]'
  if ($env:USERNAME) { $value = $value -replace [regex]::Escape($env:USERNAME), '[user]' }
  return $value
}
Write-Host 'Privacy Shield engine check'
Write-Host 'This opens only a temporary blank browser, for up to 60 seconds.'
Write-Host 'Your saved profiles and account settings are not changed.'
try {
  $report.windowsVersion = [Environment]::OSVersion.Version.ToString()
  $report.is64BitOS = [Environment]::Is64BitOperatingSystem
  $report.is64BitPowerShell = [Environment]::Is64BitProcess
  try {
    $system = Get-CimInstance Win32_OperatingSystem
    $report.windowsCaption = $system.Caption
    $report.freeMemoryMB = [Math]::Round($system.FreePhysicalMemory / 1024)
  } catch { $report.systemInfo = 'unavailable' }
  try {
    $report.graphics = @(Get-CimInstance Win32_VideoController | ForEach-Object { @{ name=$_.Name; driver=$_.DriverVersion } })
  } catch { $report.graphics = 'unavailable' }
  $report.enginePresent = Test-Path -LiteralPath $engine
  if (-not $report.enginePresent) { throw 'Patched Chromium is not installed at the expected location for this Windows user.' }
  $report.engineVersion = (Get-Item -LiteralPath $engine).VersionInfo.FileVersion
  $engineDir = Split-Path -Parent $engine
  $report.engineFiles = @('chrome.exe','chrome.dll','chrome_elf.dll','icudtl.dat','resources.pak','v8_context_snapshot.bin','locales\en-US.pak') | ForEach-Object {
    $item = Get-Item -LiteralPath (Join-Path $engineDir $_) -ErrorAction SilentlyContinue
    @{ name=$_; present=($null -ne $item); bytes=$(if ($item) { $item.Length } else { 0 }) }
  }
  try {
    $report.existingEngineProcesses = @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object {
      $_.ExecutablePath -and $_.ExecutablePath.Equals($engine, [StringComparison]::OrdinalIgnoreCase)
    } | ForEach-Object {
      # Do not include command lines, URLs, profile names, or filesystem paths.
      @{ pid=$_.ProcessId; parent=$_.ParentProcessId; headless=($_.CommandLine -match '--headless'); savedProfile=($_.CommandLine -match 'real-browser-profiles') }
    })
  } catch { $report.existingEngineProcesses = 'unavailable' }
  if (-not ('PSStartupProbe' -as [type])) { Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class PSStartupProbe {
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  public static int[] Count(uint pid) {
    int total=0, visible=0;
    EnumWindows((h,p) => { uint owner; GetWindowThreadProcessId(h,out owner);
      if(owner==pid) {total++; if(IsWindowVisible(h)) visible++;} return true;
    },IntPtr.Zero);
    return new int[]{total,visible};
  }
}
'@
  }
  New-Item -ItemType Directory -Path $testRoot | Out-Null
  $stderr = Join-Path $testRoot 'stderr.txt'
  $stdout = Join-Path $testRoot 'stdout.txt'
  $testStart = Get-Date
  $arguments = @(
    ('--user-data-dir="' + (Join-Path $testRoot 'data') + '"'),
    '--no-first-run','--no-default-browser-check','--disable-background-mode',
    '--disable-sync','--disable-background-networking','--enable-logging=stderr',
    '--log-level=0','--proxy-server=http://127.0.0.1:9',
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--new-window','--window-position=40,40','--window-size=1000,700','about:blank'
  )
  if ($AppPreferences) {
    $prefDir=Join-Path $testRoot 'data\Default'
    New-Item -ItemType Directory -Path $prefDir -Force | Out-Null
    $prefs=@{
      browser=@{check_default_browser=$false};credentials_enable_service=$true;
      profile=@{password_manager_enabled=$true;default_content_setting_values=@{geolocation=2}};
      intl=@{accept_languages='en-US,en'};
      webrtc=@{ip_handling_policy='disable_non_proxied_udp';multiple_routes_enabled=$false;nonproxied_udp_enabled=$false};
      safebrowsing=@{enabled=$true};autofill=@{profile_enabled=$false;credit_card_enabled=$false}
    }
    $prefs | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $prefDir 'Preferences') -Encoding UTF8
  }
  # Quote every captured argument using Windows command-line rules. PowerShell
  # Start-Process joins ArgumentList; passing unquoted paths would change it.
  $arguments=@($arguments[0..($arguments.Count-2)])+@($ExtraArguments | ForEach-Object {[PSLaunchCapture]::Quote($_)})+@('about:blank')
  $browser = Start-Process -FilePath $engine -ArgumentList $arguments -PassThru -WindowStyle Normal -RedirectStandardError $stderr -RedirectStandardOutput $stdout
  $owned[[int]$browser.Id] = $browser.StartTime
  $report.launchPid = $browser.Id
  $report.samples = @()
  $timer = [Diagnostics.Stopwatch]::StartNew()
  $found = $false
  do {
    # Follow only this test's Chromium descendants, never all Chrome processes.
    try {
      $processes = @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'")
      for ($pass=0; $pass -lt 3; $pass++) {
        foreach ($p in $processes) {
          if ($owned.ContainsKey([int]$p.ParentProcessId) -and $p.CreationDate -ge $testStart -and $p.ExecutablePath -and $p.ExecutablePath.Equals($engine,[StringComparison]::OrdinalIgnoreCase)) {
            $owned[[int]$p.ProcessId] = $p.CreationDate
          }
        }
      }
    } catch {}
    $sample = [ordered]@{ seconds=[Math]::Round($timer.Elapsed.TotalSeconds,1); processes=@() }
    foreach ($processId in @($owned.Keys)) {
      $p = Get-Process -Id $processId -ErrorAction SilentlyContinue
      if (-not $p) { continue }
      $counts = [PSStartupProbe]::Count([uint32]$processId)
      $sample.processes += @{ pid=$processId; totalWindows=$counts[0]; visibleWindows=$counts[1]; mainWindow=($p.MainWindowHandle -ne [IntPtr]::Zero) }
      if ($counts[1] -gt 0) { $found=$true }
    }
    $report.samples += $sample
    $browser.Refresh()
    if ($found -or $browser.HasExited) { break }
    Start-Sleep -Seconds 2
  } while ($timer.Elapsed.TotalSeconds -lt $WaitSeconds)
  $report.visibleWindow = $found
  $report.waitedSeconds = [Math]::Round($timer.Elapsed.TotalSeconds,1)
  if ($browser.HasExited) { $report.exitCode = $browser.ExitCode }
  if ($found) {
    $report.result = 'Clean engine opened a window. Investigate saved-profile state or app launch configuration next.'
    Write-Host 'PASS: the engine opened a blank browser window.'
    Start-Sleep -Seconds 2
  } else {
    $report.result = 'Clean engine did not open a window. Review engine errors, Windows compatibility, and process/window samples.'
    Write-Host 'The engine did not open a window. The report will help locate the cause.'
  }
} catch {
  $report.failure = SafeText $_.Exception.Message
  Write-Host ('Check failed: ' + $report.failure)
} finally {
  # Close only test-created processes whose recorded creation times still match.
  foreach ($processId in @($owned.Keys)) {
    try {
      $p = Get-Process -Id $processId -ErrorAction SilentlyContinue
      if ($p -and [Math]::Abs(($p.StartTime - $owned[$processId]).TotalSeconds) -lt 1) {
        Stop-Process -Id $processId -Force -ErrorAction Stop
        $p.WaitForExit(5000) | Out-Null
      }
    } catch { $report.testCleanupWarning = 'A test process could not be closed.' }
  }
  if ($stderr -and (Test-Path -LiteralPath $stderr)) {
    $report.engineMessages = @(Get-Content -LiteralPath $stderr -Tail 80 -ErrorAction SilentlyContinue | Where-Object { $_ -match 'ERROR|FATAL|WARNING|failed|denied|crash' } | Select-Object -Last 30 | ForEach-Object { SafeText $_ })
  }
  if (Test-Path -LiteralPath $testRoot) {
    $resolved = [IO.Path]::GetFullPath($testRoot)
    $tempParent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if ($resolved.StartsWith($tempParent,[StringComparison]::OrdinalIgnoreCase) -and ([IO.Path]::GetFileName($resolved) -match '^ps-support-[a-f0-9]{32}$')) {
      for ($attempt=0; $attempt -lt 5; $attempt++) {
        try { Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction Stop; break }
        catch {
          if ($attempt -eq 4) { $report.testCleanupWarning = 'Temporary test files could not all be removed.' }
          else { Start-Sleep -Seconds 1 }
        }
      }
    }
  }
  $report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $reportPath -Encoding UTF8
  Write-Host ''
  Write-Host ('Report saved: ' + $reportPath)
  Write-Host 'Comparison stage complete.'
}
