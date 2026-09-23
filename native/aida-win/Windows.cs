// Top-level windows: list, focus, snap, move between monitors (per-monitor DPI aware).
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

namespace Aida
{
    public static class Win
    {
        private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
        private delegate bool MonitorEnumProc(IntPtr monitor, IntPtr hdc, IntPtr rect, IntPtr data);

        [StructLayout(LayoutKind.Sequential)]
        public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

        [StructLayout(LayoutKind.Sequential)]
        public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }

        [DllImport("user32.dll")] private static extern bool SetProcessDpiAwarenessContext(IntPtr value);
        [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
        [DllImport("user32.dll")] private static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorEnumProc callback, IntPtr data);
        [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr hWnd);
        [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hWnd);
        [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr hWnd);
        [DllImport("user32.dll")] private static extern bool IsZoomed(IntPtr hWnd);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int max);
        [DllImport("user32.dll")] private static extern int GetWindowTextLength(IntPtr hWnd);
        [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
        [DllImport("user32.dll")] private static extern int GetWindowLong(IntPtr hWnd, int index);
        [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr hWnd, uint cmd);
        [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr hWnd);
        [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr hWnd, int cmd);
        [DllImport("user32.dll")] private static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
        [DllImport("user32.dll")] private static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
        [DllImport("user32.dll")] private static extern IntPtr MonitorFromWindow(IntPtr hWnd, uint flags);
        [DllImport("user32.dll")] private static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFO info);
        [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
        [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
        [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(IntPtr hWnd, int attribute, out RECT value, int size);
        [DllImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")] private static extern int DwmGetWindowAttributeInt(IntPtr hWnd, int attribute, out int value, int size);

        private const int GWL_EXSTYLE = -20;
        private const int WS_EX_TOOLWINDOW = 0x80;
        private const uint GW_OWNER = 4;
        private const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;
        private const int DWMWA_CLOAKED = 14;
        private const uint SWP_NOZORDER = 0x4;
        private const uint SWP_NOACTIVATE = 0x10;
        private const uint MONITOR_DEFAULTTONEAREST = 2;

        /// <summary>Per-monitor DPI awareness, so window coordinates are real pixels on scaled displays.</summary>
        public static void Init()
        {
            SetProcessDpiAwarenessContext(new IntPtr(-4));
        }

        public static List<Dictionary<string, object>> List()
        {
            List<Dictionary<string, object>> result = new List<Dictionary<string, object>>();
            EnumWindows(delegate (IntPtr hWnd, IntPtr lParam)
            {
                if (!IsWindowVisible(hWnd)) return true;
                if (GetWindow(hWnd, GW_OWNER) != IntPtr.Zero) return true;
                if ((GetWindowLong(hWnd, GWL_EXSTYLE) & WS_EX_TOOLWINDOW) != 0) return true;
                int cloaked;
                if (DwmGetWindowAttributeInt(hWnd, DWMWA_CLOAKED, out cloaked, 4) == 0 && cloaked != 0) return true;
                if (GetWindowTextLength(hWnd) == 0) return true;
                result.Add(Describe(hWnd));
                return true;
            }, IntPtr.Zero);
            return result;
        }

        public static Dictionary<string, object> Foreground()
        {
            return Describe(GetForegroundWindow());
        }

        public static Dictionary<string, object> Info(long handle)
        {
            IntPtr hWnd = new IntPtr(handle);
            if (!IsWindow(hWnd)) throw new ArgumentException("That window no longer exists.");
            return Describe(hWnd);
        }

        public static string Title(IntPtr hWnd)
        {
            int length = GetWindowTextLength(hWnd);
            StringBuilder title = new StringBuilder(length + 1);
            GetWindowText(hWnd, title, title.Capacity);
            return title.ToString();
        }

        public static string ProcessName(IntPtr hWnd)
        {
            uint pid;
            GetWindowThreadProcessId(hWnd, out pid);
            try { return Process.GetProcessById((int)pid).ProcessName; } catch (Exception) { return ""; }
        }

        private static Dictionary<string, object> Describe(IntPtr hWnd)
        {
            uint pid;
            GetWindowThreadProcessId(hWnd, out pid);
            return Json.Obj(
                "handle", hWnd.ToInt64(),
                "title", Title(hWnd),
                "process", ProcessName(hWnd),
                "pid", (int)pid,
                "minimized", IsIconic(hWnd));
        }

        /// <summary>Visible frame of a window in physical screen pixels (without invisible borders).</summary>
        public static RECT Bounds(IntPtr hWnd)
        {
            RECT frame;
            if (DwmGetWindowAttribute(hWnd, DWMWA_EXTENDED_FRAME_BOUNDS, out frame, Marshal.SizeOf(typeof(RECT))) == 0) return frame;
            GetWindowRect(hWnd, out frame);
            return frame;
        }

        public static bool IsForeground(IntPtr hWnd)
        {
            return GetForegroundWindow() == hWnd;
        }

        public static bool Act(long handle, string action)
        {
            IntPtr hWnd = new IntPtr(handle);
            if (!IsWindow(hWnd)) throw new ArgumentException("That window no longer exists.");
            switch (action)
            {
                case "focus": Focus(hWnd); return true;
                case "minimize": return ShowWindow(hWnd, 6);
                case "maximize": ShowWindow(hWnd, 3); Focus(hWnd); return true;
                case "restore": ShowWindow(hWnd, 9); Focus(hWnd); return true;
                case "close": return PostMessage(hWnd, 0x0010, IntPtr.Zero, IntPtr.Zero);
                case "snap_left": Snap(hWnd, true); return true;
                case "snap_right": Snap(hWnd, false); return true;
                case "next_monitor": return MoveToNextMonitor(hWnd);
                default: throw new ArgumentException("Unknown window action: " + action);
            }
        }

        public static void Focus(IntPtr hWnd)
        {
            if (IsIconic(hWnd)) ShowWindow(hWnd, 9);
            // Tapping Alt lets a background process take the foreground (Windows focus-stealing rules).
            keybd_event(0x12, 0, 0, UIntPtr.Zero);
            keybd_event(0x12, 0, 2, UIntPtr.Zero);
            SetForegroundWindow(hWnd);
        }

        /// <summary>Invisible resize borders (Windows 10/11) so snapped windows line up exactly.</summary>
        private static RECT Borders(IntPtr hWnd)
        {
            RECT window;
            RECT frame;
            RECT borders = new RECT();
            if (GetWindowRect(hWnd, out window) && DwmGetWindowAttribute(hWnd, DWMWA_EXTENDED_FRAME_BOUNDS, out frame, Marshal.SizeOf(typeof(RECT))) == 0)
            {
                borders.Left = frame.Left - window.Left;
                borders.Top = frame.Top - window.Top;
                borders.Right = window.Right - frame.Right;
                borders.Bottom = window.Bottom - frame.Bottom;
            }
            return borders;
        }

        private static RECT WorkArea(IntPtr monitor)
        {
            MONITORINFO info = new MONITORINFO();
            info.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
            GetMonitorInfo(monitor, ref info);
            return info.rcWork;
        }

        private static void Place(IntPtr hWnd, int x, int y, int width, int height)
        {
            RECT b = Borders(hWnd);
            SetWindowPos(hWnd, IntPtr.Zero, x - b.Left, y - b.Top, width + b.Left + b.Right, height + b.Top + b.Bottom, SWP_NOZORDER | SWP_NOACTIVATE);
        }

        private static void Snap(IntPtr hWnd, bool left)
        {
            if (IsIconic(hWnd) || IsZoomed(hWnd)) ShowWindow(hWnd, 9);
            RECT work = WorkArea(MonitorFromWindow(hWnd, MONITOR_DEFAULTTONEAREST));
            int half = (work.Right - work.Left) / 2;
            Place(hWnd, left ? work.Left : work.Left + half, work.Top, half, work.Bottom - work.Top);
            Focus(hWnd);
        }

        private static bool MoveToNextMonitor(IntPtr hWnd)
        {
            List<IntPtr> monitors = new List<IntPtr>();
            EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, delegate (IntPtr m, IntPtr hdc, IntPtr r, IntPtr d) { monitors.Add(m); return true; }, IntPtr.Zero);
            if (monitors.Count < 2) return false;

            IntPtr current = MonitorFromWindow(hWnd, MONITOR_DEFAULTTONEAREST);
            int index = monitors.IndexOf(current);
            IntPtr target = monitors[(index + 1) % monitors.Count];
            RECT from = WorkArea(current);
            RECT to = WorkArea(target);

            bool wasMaximized = IsZoomed(hWnd);
            if (wasMaximized || IsIconic(hWnd)) ShowWindow(hWnd, 9);

            RECT rect;
            GetWindowRect(hWnd, out rect);
            double sx = (double)(to.Right - to.Left) / (from.Right - from.Left);
            double sy = (double)(to.Bottom - to.Top) / (from.Bottom - from.Top);
            int x = to.Left + (int)((rect.Left - from.Left) * sx);
            int y = to.Top + (int)((rect.Top - from.Top) * sy);
            int w = Math.Min(rect.Right - rect.Left, to.Right - to.Left);
            int h = Math.Min(rect.Bottom - rect.Top, to.Bottom - to.Top);
            SetWindowPos(hWnd, IntPtr.Zero, x, y, w, h, SWP_NOZORDER | SWP_NOACTIVATE);

            if (wasMaximized) ShowWindow(hWnd, 3);
            Focus(hWnd);
            return true;
        }
    }
}
