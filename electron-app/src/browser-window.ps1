param([int]$BrowserPid, [int]$WaitMs = 15000, [switch]$PlaceOnForeground, [string]$AppId = "")
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class PSBrowserWindow {
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
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint command);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder name, int count);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int command);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out Rect rect);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromRect(ref Rect rect, uint flags);
  [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int height, uint flags);
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
      if (IsWindowVisible(h)) {
        if (visibleAny == IntPtr.Zero) visibleAny = h;
        if (visibleUnowned == IntPtr.Zero && GetWindow(h, 4) == IntPtr.Zero) { visibleUnowned = h; return false; }
      } else if (hidden == IntPtr.Zero && ChromeWidget(h)) hidden = h;
      return true;
    };
    EnumWindows(callback, IntPtr.Zero);
    if (visibleUnowned != IntPtr.Zero) return visibleUnowned;
    return visibleAny != IntPtr.Zero ? visibleAny : hidden;
  }
  static void MoveToMonitor(IntPtr h, Rect r, IntPtr monitor) {
    var info = new MonitorInfo { Size = Marshal.SizeOf(typeof(MonitorInfo)) };
    if (monitor == IntPtr.Zero || !GetMonitorInfo(monitor, ref info)) return;
    int w = Math.Min(Math.Max(r.Right - r.Left, 400), Math.Max(400, info.Work.Right - info.Work.Left));
    int height = Math.Min(Math.Max(r.Bottom - r.Top, 300), Math.Max(300, info.Work.Bottom - info.Work.Top));
    SetWindowPos(h, IntPtr.Zero, info.Work.Left, info.Work.Top, w, height, 0x0044);
  }
  // Own taskbar button per profile: Windows groups windows by AppUserModelID, so
  // without this every profile of one browser stacked under a single button.
  [StructLayout(LayoutKind.Sequential, Pack = 4)] public struct PropKey { public Guid FmtId; public uint Pid; }
  [StructLayout(LayoutKind.Explicit, Size = 24)] public struct PropVar { [FieldOffset(0)] public ushort Vt; [FieldOffset(8)] public IntPtr Ptr; }
  [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IPropStore {
    void GetCount(out uint count); void GetAt(uint index, out PropKey key);
    void GetValue(ref PropKey key, out PropVar value); void SetValue(ref PropKey key, ref PropVar value); void Commit();
  }
  [DllImport("shell32.dll")] static extern int SHGetPropertyStoreForWindow(IntPtr h, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out IPropStore store);
  public static void SetAppId(IntPtr h, string id) {
    if (h == IntPtr.Zero || String.IsNullOrEmpty(id)) return;
    var iid = new Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99");
    IPropStore store;
    if (SHGetPropertyStoreForWindow(h, ref iid, out store) != 0 || store == null) return;
    var key = new PropKey { FmtId = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), Pid = 5 };
    var value = new PropVar { Vt = 31, Ptr = Marshal.StringToCoTaskMemUni(id) };
    try { store.SetValue(ref key, ref value); store.Commit(); }
    finally { Marshal.FreeCoTaskMem(value.Ptr); Marshal.ReleaseComObject(store); }
  }
  public static void Restore(IntPtr h) { Restore(h, false); }
  public static void Restore(IntPtr h, bool placeOnForeground) {
    IntPtr foregroundMonitor = IntPtr.Zero;
    if (placeOnForeground) {
      IntPtr foreground = GetForegroundWindow();
      Rect foregroundRect;
      if (foreground != IntPtr.Zero && foreground != h && GetWindowRect(foreground, out foregroundRect)) {
        foregroundMonitor = MonitorFromRect(ref foregroundRect, 2);
      }
    }
    bool wasVisible = IsWindowVisible(h);
    if (IsIconic(h) || !wasVisible) { ShowWindowAsync(h, IsIconic(h) ? 9 : 1); System.Threading.Thread.Sleep(200); }
    Rect r;
    if (GetWindowRect(h, out r)) {
      var title = new Rect { Left = r.Left, Top = r.Top, Right = r.Right, Bottom = r.Top + 30 };
      IntPtr titleMonitor = MonitorFromRect(ref title, 0);
      IntPtr nearest = MonitorFromRect(ref r, 2);
      if (titleMonitor == IntPtr.Zero) MoveToMonitor(h, r, nearest);
      else if (foregroundMonitor != IntPtr.Zero && (foregroundMonitor != titleMonitor || !wasVisible)) MoveToMonitor(h, r, foregroundMonitor);
    }
    SetForegroundWindow(h);
  }
}
'@
$timer = [Diagnostics.Stopwatch]::StartNew()
$nextTree = [datetime]::MinValue
$tree = @([uint32]$BrowserPid)
do {
  $browser = Get-Process -Id $BrowserPid -ErrorAction SilentlyContinue
  if (-not $browser) { break }
  if ([datetime]::UtcNow -ge $nextTree) {
    $tree = @([PSBrowserWindow]::ChromeTree([uint32]$BrowserPid))
    $nextTree = [datetime]::UtcNow.AddSeconds(1)
  }
  $window = [PSBrowserWindow]::Find([uint32[]]$tree)
  if ($window -eq [IntPtr]::Zero) { $window = $browser.MainWindowHandle }
  if ($window -ne [IntPtr]::Zero) {
    if ($AppId) { try { [PSBrowserWindow]::SetAppId($window, $AppId) } catch {} }
    [PSBrowserWindow]::Restore($window, [bool]$PlaceOnForeground)
    '{"ok":true}'
    exit 0
  }
  Start-Sleep -Milliseconds 200
} while ($timer.ElapsedMilliseconds -lt $WaitMs)
'{"ok":false,"reason":"window-missing"}'
