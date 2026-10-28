param(
  [int]$BrowserPid,
  [string]$CmdFile,
  [string]$HostFile,
  [string]$PosFile
)
$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class PSMacChrome {
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct ProcessEntry {
    public uint Size, Usage, ProcessId;
    public IntPtr Heap;
    public uint ModuleId, ThreadCount, ParentProcessId;
    public int Priority;
    public uint Flags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string Name;
  }
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint command);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder name, int count);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int command);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out Rect rect);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int height, uint flags);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint from, uint to, bool attach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern int SetWindowRgn(IntPtr h, IntPtr region, bool redraw);
  [DllImport("dwmapi.dll")] public static extern int DwmSetWindowAttribute(IntPtr h, int attr, ref int pref, int size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool Process32First(IntPtr snap, ref ProcessEntry entry);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool Process32Next(IntPtr snap, ref ProcessEntry entry);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
  public static uint[] Tree(uint root) {
    var ids = new HashSet<uint>();
    ids.Add(root);
    var rows = new List<uint[]>();
    IntPtr snap = CreateToolhelp32Snapshot(2, 0);
    if (snap == IntPtr.Zero || snap == new IntPtr(-1)) {
      var only = new uint[ids.Count];
      ids.CopyTo(only);
      return only;
    }
    try {
      var entry = new ProcessEntry();
      entry.Size = (uint)Marshal.SizeOf(typeof(ProcessEntry));
      if (Process32First(snap, ref entry)) {
        do {
          rows.Add(new uint[] { entry.ProcessId, entry.ParentProcessId });
          entry.Size = (uint)Marshal.SizeOf(typeof(ProcessEntry));
        } while (Process32Next(snap, ref entry));
      }
    } finally { CloseHandle(snap); }
    bool changed = true;
    for (int depth = 0; depth < 6 && changed; depth++) {
      changed = false;
      foreach (uint[] row in rows) {
        if (ids.Contains(row[1]) && ids.Add(row[0])) changed = true;
      }
    }
    var result = new uint[ids.Count];
    ids.CopyTo(result);
    return result;
  }
  static bool ChromeWidget(IntPtr h) {
    var name = new StringBuilder(64);
    if (GetClassName(h, name, name.Capacity) <= 0) return false;
    return name.ToString().StartsWith("Chrome_WidgetWin_");
  }
  public static IntPtr Find(uint[] pids) {
    if (pids == null || pids.Length == 0) return IntPtr.Zero;
    IntPtr best = IntPtr.Zero, hidden = IntPtr.Zero;
    int bestArea = 0, hiddenArea = 0;
    EnumProc callback = (h, p) => {
      uint owner;
      GetWindowThreadProcessId(h, out owner);
      bool match = false;
      for (int i = 0; i < pids.Length; i++) if (pids[i] == owner) { match = true; break; }
      if (!match || !ChromeWidget(h)) return true;
      Rect r;
      if (!GetWindowRect(h, out r)) return true;
      int area = Math.Max(0, r.Right - r.Left) * Math.Max(0, r.Bottom - r.Top);
      if (IsWindowVisible(h)) {
        if (area > bestArea) { bestArea = area; best = h; }
      } else if (area > hiddenArea) { hiddenArea = area; hidden = h; }
      return true;
    };
    EnumWindows(callback, IntPtr.Zero);
    return best != IntPtr.Zero ? best : hidden;
  }
  public static bool InTree(uint[] pids) {
    IntPtr foreground = GetForegroundWindow();
    if (foreground == IntPtr.Zero) return true;
    uint pid;
    GetWindowThreadProcessId(foreground, out pid);
    if (pid == 0) return true;
    for (int i = 0; i < pids.Length; i++) if (pids[i] == pid) return true;
    return false;
  }
  public static bool HostFocused(long host) {
    if (host == 0) return false;
    IntPtr foreground = GetForegroundWindow();
    return foreground != IntPtr.Zero && foreground.ToInt64() == host;
  }
  public static void Move(IntPtr h, int x, int y) {
    if (h == IntPtr.Zero) return;
    SetWindowPos(h, IntPtr.Zero, x, y, 0, 0, 0x0015);
  }
  public static void Focus(IntPtr h) {
    if (h == IntPtr.Zero) return;
    IntPtr foreground = GetForegroundWindow();
    uint from = GetCurrentThreadId();
    uint to;
    GetWindowThreadProcessId(foreground, out to);
    if (to != 0) AttachThreadInput(from, to, true);
    SetForegroundWindow(h);
    if (to != 0) AttachThreadInput(from, to, false);
  }
  public static void Act(IntPtr h, string action) {
    if (h == IntPtr.Zero || string.IsNullOrEmpty(action)) return;
    if (action == "close") PostMessage(h, 0x0010, IntPtr.Zero, IntPtr.Zero);
    else if (action == "min") ShowWindowAsync(h, 6);
    else if (action == "zoom") ShowWindowAsync(h, IsZoomed(h) ? 9 : 3);
  }
  public static void Round(IntPtr h) {
    if (h == IntPtr.Zero) return;
    SetWindowRgn(h, IntPtr.Zero, true);
    int pref = IsZoomed(h) ? 1 : 2;
    try { DwmSetWindowAttribute(h, 33, ref pref, 4); } catch {}
  }
  public static void Stack(IntPtr overlay, IntPtr chrome) {
    if (overlay == IntPtr.Zero || chrome == IntPtr.Zero) return;
    if (GetWindow(overlay, 3) == chrome) return;
    SetWindowPos(overlay, IntPtr.Zero, 0, 0, 0, 0, 0x0013);
    SetWindowPos(chrome, overlay, 0, 0, 0, 0, 0x0013);
  }
  public static int Dpi(IntPtr h) {
    uint dpi = 96;
    try { dpi = GetDpiForWindow(h); } catch { dpi = 96; }
    if (dpi < 96) dpi = 96;
    return (int)dpi;
  }
}
'@

function Emit([string]$line) {
  [Console]::Out.WriteLine($line)
  [Console]::Out.Flush()
}

function ToolbarHeight([IntPtr]$h) {
  try {
    $el = [System.Windows.Automation.AutomationElement]::FromHandle($h)
    if ($el -eq $null) { return 0 }
    $cond = New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
      [System.Windows.Automation.ControlType]::Document)
    $docs = $el.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
    $bestTop = 0.0
    $bestArea = 0.0
    foreach ($doc in $docs) {
      $rect = $doc.Current.BoundingRectangle
      $area = $rect.Width * $rect.Height
      if ($area -gt $bestArea) { $bestArea = $area; $bestTop = $rect.Top }
    }
    if ($bestArea -lt 1000) { return 0 }
    $wr = New-Object PSMacChrome+Rect
    if (-not [PSMacChrome]::GetWindowRect($h, [ref]$wr)) { return 0 }
    $height = [int][Math]::Round($bestTop - $wr.Top)
    if ($height -lt 48 -or $height -gt 280) { return 0 }
    return $height
  } catch { return 0 }
}

function Escape-Keys([string]$text) {
  $sb = New-Object System.Text.StringBuilder
  foreach ($ch in $text.ToCharArray()) {
    $s = [string]$ch
    if ('+^%~(){}[]'.Contains($s)) { [void]$sb.Append('{' + $s + '}') }
    else { [void]$sb.Append($s) }
  }
  return $sb.ToString()
}

function Send-Chord([IntPtr]$h, [string]$keys) {
  try { [PSMacChrome]::Focus($h) } catch {}
  Start-Sleep -Milliseconds 50
  try { [System.Windows.Forms.SendKeys]::SendWait($keys) } catch {}
}

function Send-Go([IntPtr]$h, [string]$text) {
  if (-not $text) { return }
  $clean = ($text -replace '[\r\n]', '')
  if ($clean.Length -gt 2000) { $clean = $clean.Substring(0, 2000) }
  Send-Chord $h '^l'
  Start-Sleep -Milliseconds 40
  try { [System.Windows.Forms.SendKeys]::SendWait((Escape-Keys $clean)) } catch {}
  try { [System.Windows.Forms.SendKeys]::SendWait('{ENTER}') } catch {}
}

function Invoke-Menu([IntPtr]$h) {
  try {
    $el = [System.Windows.Automation.AutomationElement]::FromHandle($h)
    if ($el -eq $null) { return }
    $cond = New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
      [System.Windows.Automation.ControlType]::Button)
    $buttons = $el.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
    foreach ($button in $buttons) {
      $name = ''
      try { $name = [string]$button.Current.Name } catch { $name = '' }
      if ($name -notmatch 'Customize and control') { continue }
      $pattern = $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
      if ($pattern -ne $null) { $pattern.Invoke() }
      return
    }
  } catch {}
}

$tree = @([uint32]$BrowserPid)
$nextTree = [datetime]::MinValue
$toolbar = 0
$lastSize = ''
$lastGen = [int64]0
$last = ''
while ($true) {
  $browser = Get-Process -Id $BrowserPid -ErrorAction SilentlyContinue
  if (-not $browser) { Emit '{"alive":false}'; exit 0 }
  if ([datetime]::UtcNow -ge $nextTree) {
    try { $tree = @([PSMacChrome]::Tree([uint32]$BrowserPid)) } catch { $tree = @([uint32]$BrowserPid) }
    $nextTree = [datetime]::UtcNow.AddSeconds(1)
  }
  $window = [IntPtr]::Zero
  try { $window = [PSMacChrome]::Find([uint32[]]$tree) } catch { $window = [IntPtr]::Zero }
  if ($window -eq [IntPtr]::Zero) { $window = $browser.MainWindowHandle }
  if ($PosFile -and (Test-Path -LiteralPath $PosFile) -and $window -ne [IntPtr]::Zero) {
    $pos = ''
    try { $pos = [IO.File]::ReadAllText($PosFile).Trim() } catch { $pos = '' }
    $bits = $pos -split "`t"
    if ($bits.Length -ge 3) {
      $gen = [int64]0
      $px = 0
      $py = 0
      [void][int64]::TryParse($bits[0], [ref]$gen)
      [void][int]::TryParse($bits[1], [ref]$px)
      [void][int]::TryParse($bits[2], [ref]$py)
      if ($gen -gt $lastGen) {
        $lastGen = $gen
        try { [PSMacChrome]::Move($window, $px, $py) } catch {}
      }
    }
  }
  if ($CmdFile -and (Test-Path -LiteralPath $CmdFile)) {
    $cmd = ''
    try { $cmd = [IO.File]::ReadAllText($CmdFile).Trim() } catch { $cmd = '' }
    if ($cmd) {
      try { [IO.File]::WriteAllText($CmdFile, '') } catch {}
      if ($window -ne [IntPtr]::Zero) {
        $verb = $cmd
        $arg = ''
        $tabAt = $cmd.IndexOf("`t")
        if ($tabAt -ge 0) {
          $verb = $cmd.Substring(0, $tabAt)
          $arg = $cmd.Substring($tabAt + 1)
        }
        try {
          if ($verb -eq 'close' -or $verb -eq 'min' -or $verb -eq 'zoom') { [PSMacChrome]::Act($window, $verb) }
          elseif ($verb -eq 'back') { Send-Chord $window '%{LEFT}' }
          elseif ($verb -eq 'fwd') { Send-Chord $window '%{RIGHT}' }
          elseif ($verb -eq 'reload') { Send-Chord $window '{F5}' }
          elseif ($verb -eq 'newtab') { Send-Chord $window '^t' }
          elseif ($verb -eq 'closetab') { Send-Chord $window '^w' }
          elseif ($verb -eq 'star') { Send-Chord $window '^d' }
          elseif ($verb -eq 'go') { Send-Go $window $arg }
          elseif ($verb -eq 'tab') {
            $n = 0
            [void][int]::TryParse($arg, [ref]$n)
            if ($n -ge 1 -and $n -le 8) { Send-Chord $window ('^' + $n) }
          }
          elseif ($verb -eq 'menu') { Invoke-Menu $window }
        } catch {}
      }
    }
  }
  $line = '{"alive":true,"ours":false,"iconic":false,"visible":false,"zoomed":false,"l":0,"t":0,"r":0,"b":0,"toolbar":0}'
  if ($window -ne [IntPtr]::Zero) {
    $rect = New-Object PSMacChrome+Rect
    $got = $false
    try { $got = [PSMacChrome]::GetWindowRect($window, [ref]$rect) } catch { $got = $false }
    if ($got) {
      $width = $rect.Right - $rect.Left
      $height = $rect.Bottom - $rect.Top
      $sizeKey = "$width x $height"
      if ($sizeKey -ne $lastSize) {
        $lastSize = $sizeKey
        try { [PSMacChrome]::Round($window) } catch {}
        $toolbar = 0
      }
      if ($toolbar -le 0) {
        try { $toolbar = ToolbarHeight $window } catch { $toolbar = 0 }
        if ($toolbar -le 0) {
          $dpi = 96
          try { $dpi = [PSMacChrome]::Dpi($window) } catch { $dpi = 96 }
          $toolbar = [int][Math]::Round(88.0 * $dpi / 96.0)
        }
      }
      $ours = $false
      try { $ours = [PSMacChrome]::InTree([uint32[]]$tree) } catch { $ours = $false }
      if (-not $ours -and $HostFile -and (Test-Path -LiteralPath $HostFile)) {
        $hostRaw = ''
        try { $hostRaw = [IO.File]::ReadAllText($HostFile).Trim() } catch { $hostRaw = '' }
        $hostHwnd = [int64]0
        [void][int64]::TryParse($hostRaw, [ref]$hostHwnd)
        try { if ([PSMacChrome]::HostFocused($hostHwnd)) { $ours = $true } } catch {}
      }
      $iconic = [PSMacChrome]::IsIconic($window)
      $visible = [PSMacChrome]::IsWindowVisible($window)
      $zoomed = [PSMacChrome]::IsZoomed($window)
      $line = '{"alive":true,"ours":' + $(if ($ours) { 'true' } else { 'false' }) + ',"iconic":' + $(if ($iconic) { 'true' } else { 'false' }) + ',"visible":' + $(if ($visible) { 'true' } else { 'false' }) + ',"zoomed":' + $(if ($zoomed) { 'true' } else { 'false' }) + ',"l":' + $rect.Left + ',"t":' + $rect.Top + ',"r":' + $rect.Right + ',"b":' + $rect.Bottom + ',"toolbar":' + $toolbar + '}'
      if ($ours -and $HostFile -and (Test-Path -LiteralPath $HostFile)) {
        $hostRaw = ''
        try { $hostRaw = [IO.File]::ReadAllText($HostFile).Trim() } catch { $hostRaw = '' }
        $hostHwnd = [int64]0
        [void][int64]::TryParse($hostRaw, [ref]$hostHwnd)
        if ($hostHwnd -ne 0) {
          $overlay = [IntPtr]$hostHwnd
          try { [PSMacChrome]::Stack($overlay, $window) } catch {}
        }
      }
    }
  }
  if ($line -ne $last) { Emit $line; $last = $line }
  Start-Sleep -Milliseconds 40
}
