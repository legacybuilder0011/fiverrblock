# One round: Start the profile through the app, wait for the guard to say safe, then close it.
param([string]$ProfileId = "mwks46fh48xneg", [int]$Round = 1, [int]$WaitSec = 90)
$log = "$env:USERPROFILE\OneDrive\Desktop\privacy-shield-error.txt"
$since = (Get-Date).ToUniversalTime().AddSeconds(-2)
"== round $Round start $(Get-Date -Format HH:mm:ss)"
node "$PSScriptRoot\app-invoke.js" PROFILE_OPEN_WINDOW "{profileId:'$ProfileId'}"
$deadline = (Get-Date).AddSeconds($WaitSec); $safe = $null
while ((Get-Date) -lt $deadline -and -not $safe) {
  Start-Sleep 3
  $lines = Get-Content $log -Tail 400 | ? { $_ -match $ProfileId -and $_ -match '^(\S+)Z' -and ([datetime]::Parse($Matches[1]) -gt $since) }
  $safe = $lines | ? { $_ -match 'safe=true' } | select -First 1
}
$lines | ? { $_ -match 'guard|reopen' } | % { "   " + $_.Substring(11, [Math]::Min(240, $_.Length - 11)) }
if ($safe) { "RESULT round ${Round}: CONNECTED + SAFE" } else { "RESULT round ${Round}: NOT CONNECTED within $WaitSec s" }
