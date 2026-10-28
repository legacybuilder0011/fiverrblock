param([int]$CaptureSeconds = 120)
$ErrorActionPreference = 'Stop'
$CaptureSeconds = [Math]::Max(5,[Math]::Min(180,$CaptureSeconds))
$report = [ordered]@{ diagnosticVersion=2; timeUtc=[DateTime]::UtcNow.ToString('o'); tests=@() }
$desktop=[Environment]::GetFolderPath('Desktop')
if (-not $desktop -or -not (Test-Path -LiteralPath $desktop)) { $desktop=$env:TEMP }
$reportPath=Join-Path $desktop 'Privacy-Shield-Launch-Report.txt'
$engine=Join-Path $env:APPDATA 'privacy-shield\fingerprint-chromium\ungoogled-chromium_148.0.7778.215-1.1_windows_x64\chrome.exe'
$work=Join-Path ([IO.Path]::GetTempPath()) ('ps-compare-'+[Guid]::NewGuid().ToString('N'))
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class PSLaunchCapture {
  [DllImport("shell32.dll",SetLastError=true)] static extern IntPtr CommandLineToArgvW([MarshalAs(UnmanagedType.LPWStr)] string s,out int n);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr p);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb,IntPtr p);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  public delegate bool EnumProc(IntPtr h,IntPtr p);
  public static string[] Split(string s) {
    int n; var p=CommandLineToArgvW(s,out n); if(p==IntPtr.Zero)throw new Exception("Argument parsing failed");
    try { var a=new string[n]; for(int i=0;i<n;i++) a[i]=Marshal.PtrToStringUni(Marshal.ReadIntPtr(p,i*IntPtr.Size)); return a; }
    finally {LocalFree(p);}
  }
  public static string Quote(string s) {
    var b=new StringBuilder("\""); int slashes=0;
    foreach(char c in s) { if(c=='\\'){slashes++;continue;}
      if(c=='"'){b.Append('\\',slashes*2+1);b.Append(c);}
      else{b.Append('\\',slashes);b.Append(c);} slashes=0;
    } b.Append('\\',slashes*2); b.Append('"'); return b.ToString();
  }
  public static int Visible(uint pid) {
    int count=0; EnumWindows((h,p)=>{uint owner;GetWindowThreadProcessId(h,out owner);
      if(owner==pid&&IsWindowVisible(h))count++;return true;},IntPtr.Zero);return count;
  }
}
'@
try {
  if (-not (Test-Path -LiteralPath $engine)) { throw 'The installed Patched Chromium engine was not found.' }
  $known=@(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | ForEach-Object { $_.ProcessId })
  Write-Host 'Keep Privacy Shield OPEN on this PC.'
  Write-Host 'NOW click Start once on the Patched Chromium profile that fails.'
  Write-Host 'This check will observe that attempt, then open temporary blank test windows.'
  Write-Host 'Saved profiles and account data will not be changed.'
  $timer=[Diagnostics.Stopwatch]::StartNew()
  $captured=$null
  do {
    $candidates=@(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object {
      $_.ProcessId -notin $known -and $_.ExecutablePath -and
      $_.ExecutablePath.Equals($engine,[StringComparison]::OrdinalIgnoreCase) -and
      $_.CommandLine -match '--user-data-dir=' -and $_.CommandLine -notmatch '--type='
    })
    if ($candidates.Count) {$captured=$candidates[0];break}
    Start-Sleep -Milliseconds 350
  } while ($timer.Elapsed.TotalSeconds -lt $CaptureSeconds)
  if (-not $captured) {throw 'No new Patched Chromium Start was detected. Keep Privacy Shield open, run this check again, then click Start.'}
  $parsed=[PSLaunchCapture]::Split($captured.CommandLine)
  # Raw command lines are held only in memory. Do not write URLs, proxy values,
  # account identifiers, file paths, or fingerprint values into the report.
  $report.capturedSwitches=@($parsed | Where-Object {$_ -match '^--[a-zA-Z0-9-]+(?:=|$)'} | ForEach-Object {($_ -split '=',2)[0]} | Sort-Object -Unique)
  $report.originalPid=$captured.ProcessId
  $report.originalSamples=@()
  $observed=[Diagnostics.Stopwatch]::StartNew()
  do {
    $p=Get-Process -Id $captured.ProcessId -ErrorAction SilentlyContinue
    if (-not $p) {break}
    $report.originalSamples+=@{seconds=[Math]::Round($observed.Elapsed.TotalSeconds,1);visibleWindows=[PSLaunchCapture]::Visible([uint32]$p.Id);mainWindow=($p.MainWindowHandle -ne [IntPtr]::Zero)}
    Start-Sleep -Seconds 1
  } while ($observed.Elapsed.TotalSeconds -lt 22)
  $report.originalStillRunning=($null -ne (Get-Process -Id $captured.ProcessId -ErrorAction SilentlyContinue))
  Write-Host 'Captured the Start attempt. Running isolated comparisons...'
  # Preserve only the app's known startup switches. All destinations and storage
  # paths are replaced by the runner; no saved URL is opened.
  $allowed='^--(?:profile-directory|no-first-run|no-default-browser-check|disable-background-mode|disable-sync|disable-features|force-webrtc-ip-handling-policy|new-window|window-size|fingerprint|fingerprint-platform|fingerprint-brand|fingerprint-brand-version|fingerprint-platform-version|fingerprint-hardware-concurrency|timezone|extension-mime-request-handling|lang|accept-lang|disable-quic)(?:=|$)'
  $settings=@($parsed | Where-Object {$_ -match $allowed})
  $extension=@()
  $extensionSwitch=@($parsed | Where-Object {$_ -like '--load-extension=*'})
  if ($extensionSwitch.Count) {
    # Only the shipped store helper can be loaded in this diagnostic. Never load
    # user extensions that may make their own requests or contain account data.
    $paths=$extensionSwitch[0].Substring('--load-extension='.Length).Split(',')
    $bundled=@($paths | Where-Object { $_ -match '[\\/]vendor[\\/]chromium-web-store$' -and (Test-Path -LiteralPath (Join-Path $_ 'manifest.json')) })
    if ($bundled.Count -eq 1) {$extension=@('--load-extension='+$bundled[0])}
    $report.otherExtensionsOmitted=$paths.Count-$bundled.Count
  }
  $report.bundledHelperIncluded=($extension.Count -gt 0)
  New-Item -ItemType Directory -Path $work | Out-Null
  $tests=@(@{name='captured-settings-clean-storage';options=@($settings)+@($extension);preferences=$true})
  if ($extension.Count) { $tests+=@{name='same-settings-without-bundled-helper';options=@($settings);preferences=$true} }
  $tests+=@{name='plain-engine-same-session';options=@();preferences=$false}
  foreach ($test in $tests) {
    Write-Host ('Checking: '+$test.name)
    $resultFile=Join-Path $work ($test.name+'.json')
    & (Join-Path $PSScriptRoot 'Engine-Test.ps1') -WaitSeconds 35 -ExtraArguments $test.options -ResultPath $resultFile -AppPreferences $test.preferences
    $result=Get-Content -LiteralPath $resultFile -Raw | ConvertFrom-Json
    $report.tests+=@{
      name=$test.name;visibleWindow=$result.visibleWindow;waitedSeconds=$result.waitedSeconds;
      failure=$result.failure;exitCode=$result.exitCode;engineMessages=$result.engineMessages;
      samples=$result.samples;cleanupWarning=$result.testCleanupWarning
    }
  }
} catch {
  # Exception messages may contain local paths. Only fixed diagnostic messages
  # are retained; stack traces and command text are intentionally omitted.
  $message=[string]$_.Exception.Message
  $message=$message -replace '(?i)[a-z]:\\[^\r\n]*','[local path omitted]'
  $message=$message -replace '(?i)https?://\S+','[URL omitted]'
  if($env:USERNAME){$message=$message -replace [regex]::Escape($env:USERNAME),'[user]'}
  $report.failure=$message
  Write-Host ('Check stopped: '+$message)
} finally {
  if (Test-Path -LiteralPath $work) {
    $resolved=[IO.Path]::GetFullPath($work)
    $tempParent=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')+'\'
    if($resolved.StartsWith($tempParent,[StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetFileName($resolved) -match '^ps-compare-[a-f0-9]{32}$') {
      Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
  $report | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $reportPath -Encoding UTF8
  Write-Host ('Done. Send this file: '+$reportPath)
}
