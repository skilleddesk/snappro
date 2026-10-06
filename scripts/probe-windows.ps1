# Lists SnapPro windows with their screen rectangles (verification helper).
$src = @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class WinProbe {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public static System.Collections.Generic.List<string> Find(uint targetPid) {
    var found = new System.Collections.Generic.List<string>();
    EnumWindows((h, l) => {
      var sb = new StringBuilder(256);
      GetWindowText(h, sb, 256);
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (pid == targetPid) {
        RECT r; GetWindowRect(h, out r);
        found.Add(string.Format("{0}|{1}|{2}|{3}|{4}|{5}",
          sb.ToString(), IsWindowVisible(h), r.Left, r.Top, r.Right, r.Bottom));
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
"@
Add-Type -TypeDefinition $src -Language CSharp
$pid2 = (Get-Process snappro).Id
[WinProbe]::Find([uint32]$pid2) | ForEach-Object { $_ }