param([int]$BrowserPid, [string]$CmdFile)
$ErrorActionPreference = 'Continue'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class PSOsFrame {
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct MonitorInfo { public int Size; public Rect Monitor, Work; public uint Flags; }
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
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromRect(ref Rect rect, uint flags);
  [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int height, uint flags);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr h);
  [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr h, IntPtr dc);
  [DllImport("gdi32.dll")] public static extern uint GetPixel(IntPtr dc, int x, int y);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool Process32First(IntPtr snap, ref ProcessEntry entry);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool Process32Next(IntPtr snap, ref ProcessEntry entry);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
  public static uint[] ChromeTree(uint root) {
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
    IntPtr visibleUnowned = IntPtr.Zero, visibleAny = IntPtr.Zero, hidden = IntPtr.Zero;
    EnumProc callback = (h, p) => {
      uint owner;
      GetWindowThreadProcessId(h, out owner);
      bool match = false;
      for (int i = 0; i < pids.Length; i++) if (pids[i] == owner) { match = true; break; }
      if (!match) return true;
      if (!ChromeWidget(h)) return true;
      if (IsWindowVisible(h)) {
        if (visibleAny == IntPtr.Zero) visibleAny = h;
        if (visibleUnowned == IntPtr.Zero && GetWindow(h, 4) == IntPtr.Zero) { visibleUnowned = h; return false; }
      } else if (hidden == IntPtr.Zero) hidden = h;
      return true;
    };
    EnumWindows(callback, IntPtr.Zero);
    if (visibleUnowned != IntPtr.Zero) return visibleUnowned;
    return visibleAny != IntPtr.Zero ? visibleAny : hidden;
  }
  public static bool Ours(uint[] pids) {
    IntPtr foreground = GetForegroundWindow();
    if (foreground == IntPtr.Zero) return true;
    uint pid;
    GetWindowThreadProcessId(foreground, out pid);
    if (pid == 0) return true;
    for (int i = 0; i < pids.Length; i++) if (pids[i] == pid) return true;
    return false;
  }
  public static string Sample(IntPtr h) {
    Rect r;
    if (!GetWindowRect(h, out r)) return "";
    IntPtr dc = GetDC(h);
    if (dc == IntPtr.Zero) return "";
    try {
      int width = Math.Max(1, r.Right - r.Left);
      uint px = GetPixel(dc, Math.Max(8, width / 2), 3);
      if (px == 0xFFFFFFFF) return "";
      return string.Format("#{0:X2}{1:X2}{2:X2}", px & 0xFF, (px >> 8) & 0xFF, (px >> 16) & 0xFF);
    } finally { ReleaseDC(h, dc); }
  }
  public static void MakeRoom(IntPtr h) {
    if (h == IntPtr.Zero) return;
    if (IsZoomed(h)) {
      ShowWindowAsync(h, 9);
      System.Threading.Thread.Sleep(250);
    }
    Rect r;
    if (!GetWindowRect(h, out r)) return;
    IntPtr monitor = MonitorFromRect(ref r, 2);
    var info = new MonitorInfo { Size = Marshal.SizeOf(typeof(MonitorInfo)) };
    if (monitor == IntPtr.Zero || !GetMonitorInfo(monitor, ref info)) return;
    uint dpi = 96;
    try { dpi = GetDpiForWindow(h); } catch { dpi = 96; }
    if (dpi < 96) dpi = 96;
    int bar = (int)Math.Round(32.0 * dpi / 96.0);
    if (r.Top >= info.Work.Top + bar) return;
    int height = r.Bottom - r.Top;
    int maxH = info.Work.Bottom - (info.Work.Top + bar);
    if (maxH < 300) return;
    if (height > maxH) height = maxH;
    SetWindowPos(h, IntPtr.Zero, r.Left, info.Work.Top + bar, Math.Max(400, r.Right - r.Left), height, 0x0014);
  }
  public static void Act(IntPtr h, string action) {
    if (h == IntPtr.Zero || string.IsNullOrEmpty(action)) return;
    if (action == "close") PostMessage(h, 0x0010, IntPtr.Zero, IntPtr.Zero);
    else if (action == "min") ShowWindowAsync(h, 6);
    else if (action == "zoom") ShowWindowAsync(h, IsZoomed(h) ? 9 : 3);
  }
}
'@
function Emit([string]$line) {
  [Console]::Out.WriteLine($line)
  [Console]::Out.Flush()
}
$madeRoom = $false
$nextTree = [datetime]::MinValue
$tree = @([uint32]$BrowserPid)
$last = ""
while ($true) {
  $browser = Get-Process -Id $BrowserPid -ErrorAction SilentlyContinue
  if (-not $browser) { Emit '{"alive":false}'; exit 0 }
  if ([datetime]::UtcNow -ge $nextTree) {
    try { $tree = @([PSOsFrame]::ChromeTree([uint32]$BrowserPid)) } catch { $tree = @([uint32]$BrowserPid) }
    $nextTree = [datetime]::UtcNow.AddSeconds(1)
  }
  $window = [IntPtr]::Zero
  try { $window = [PSOsFrame]::Find([uint32[]]$tree) } catch { $window = [IntPtr]::Zero }
  if ($window -eq [IntPtr]::Zero) { $window = $browser.MainWindowHandle }
  if ($CmdFile -and (Test-Path -LiteralPath $CmdFile)) {
    $cmd = ""
    try { $cmd = [IO.File]::ReadAllText($CmdFile).Trim().ToLowerInvariant() } catch { $cmd = "" }
    if ($cmd) {
      try { [IO.File]::WriteAllText($CmdFile, "") } catch {}
      if ($window -ne [IntPtr]::Zero) { try { [PSOsFrame]::Act($window, $cmd) } catch {} }
    }
  }
  if (-not $madeRoom -and $window -ne [IntPtr]::Zero) {
    try { [PSOsFrame]::MakeRoom($window) } catch {}
    $madeRoom = $true
    Start-Sleep -Milliseconds 200
    continue
  }
  $line = '{"alive":true,"hwnd":"0","ours":false,"iconic":false,"visible":false,"l":0,"t":0,"r":0,"b":0,"strip":""}'
  if ($window -ne [IntPtr]::Zero) {
    $rect = New-Object PSOsFrame+Rect
    $got = $false
    try { $got = [PSOsFrame]::GetWindowRect($window, [ref]$rect) } catch { $got = $false }
    if ($got) {
      $ours = $false
      $strip = ""
      try { $ours = [PSOsFrame]::Ours([uint32[]]$tree) } catch { $ours = $false }
      try { $strip = [PSOsFrame]::Sample($window) } catch { $strip = "" }
      $iconic = [PSOsFrame]::IsIconic($window)
      $visible = [PSOsFrame]::IsWindowVisible($window)
      $line = '{"alive":true,"hwnd":"' + $window.ToInt64() + '","ours":' + $(if ($ours) { "true" } else { "false" }) + ',"iconic":' + $(if ($iconic) { "true" } else { "false" }) + ',"visible":' + $(if ($visible) { "true" } else { "false" }) + ',"l":' + $rect.Left + ',"t":' + $rect.Top + ',"r":' + $rect.Right + ',"b":' + $rect.Bottom + ',"strip":"' + $strip + '"}'
    }
  }
  if ($line -ne $last) { Emit $line; $last = $line }
  Start-Sleep -Milliseconds 90
}
