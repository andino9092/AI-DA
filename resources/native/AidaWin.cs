// Windows helpers for AI-DA, compiled at runtime by Windows PowerShell 5.1 (C# 5 syntax only:
// no string interpolation, expression-bodied members or out variables).
// Phase 3 replaces this with a proper .NET 8 sidecar exposing the same commands.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

namespace Aida
{
    [ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IAudioEndpointVolume
    {
        int RegisterControlChangeNotify(IntPtr notify);
        int UnregisterControlChangeNotify(IntPtr notify);
        int GetChannelCount(out uint count);
        int SetMasterVolumeLevel(float levelDb, ref Guid context);
        int SetMasterVolumeLevelScalar(float level, ref Guid context);
        int GetMasterVolumeLevel(out float levelDb);
        int GetMasterVolumeLevelScalar(out float level);
        int SetChannelVolumeLevel(uint channel, float levelDb, ref Guid context);
        int SetChannelVolumeLevelScalar(uint channel, float level, ref Guid context);
        int GetChannelVolumeLevel(uint channel, out float levelDb);
        int GetChannelVolumeLevelScalar(uint channel, out float level);
        int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid context);
        int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMMDevice
    {
        int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
    }

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMMDeviceEnumerator
    {
        int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
        int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
    }

    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    internal class MMDeviceEnumerator
    {
    }

    public static class Audio
    {
        private static IAudioEndpointVolume Endpoint()
        {
            IMMDeviceEnumerator enumerator = (IMMDeviceEnumerator)new MMDeviceEnumerator();
            IMMDevice device;
            // eRender = 0, eMultimedia = 1
            Marshal.ThrowExceptionForHR(enumerator.GetDefaultAudioEndpoint(0, 1, out device));
            Guid iid = typeof(IAudioEndpointVolume).GUID;
            object endpoint;
            // CLSCTX_ALL = 23
            Marshal.ThrowExceptionForHR(device.Activate(ref iid, 23, IntPtr.Zero, out endpoint));
            return (IAudioEndpointVolume)endpoint;
        }

        public static int GetVolume()
        {
            float level;
            Marshal.ThrowExceptionForHR(Endpoint().GetMasterVolumeLevelScalar(out level));
            return (int)Math.Round(level * 100);
        }

        public static int SetVolume(int percent)
        {
            int clamped = Math.Max(0, Math.Min(100, percent));
            Guid context = Guid.Empty;
            Marshal.ThrowExceptionForHR(Endpoint().SetMasterVolumeLevelScalar(clamped / 100f, ref context));
            return GetVolume();
        }

        public static bool GetMute()
        {
            bool muted;
            Marshal.ThrowExceptionForHR(Endpoint().GetMute(out muted));
            return muted;
        }

        public static bool SetMute(bool mute)
        {
            Guid context = Guid.Empty;
            Marshal.ThrowExceptionForHR(Endpoint().SetMute(mute, ref context));
            return GetMute();
        }
    }

    public class WindowInfo
    {
        public long Handle { get; set; }
        public string Title { get; set; }
        public string Process { get; set; }
        public int Pid { get; set; }
        public bool Minimized { get; set; }
    }

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

        public static WindowInfo[] List()
        {
            List<WindowInfo> result = new List<WindowInfo>();
            EnumWindows(delegate (IntPtr hWnd, IntPtr lParam)
            {
                if (!IsWindowVisible(hWnd)) return true;
                if (GetWindow(hWnd, GW_OWNER) != IntPtr.Zero) return true;
                if ((GetWindowLong(hWnd, GWL_EXSTYLE) & WS_EX_TOOLWINDOW) != 0) return true;
                int cloaked;
                if (DwmGetWindowAttributeInt(hWnd, DWMWA_CLOAKED, out cloaked, 4) == 0 && cloaked != 0) return true;
                int length = GetWindowTextLength(hWnd);
                if (length == 0) return true;
                StringBuilder title = new StringBuilder(length + 1);
                GetWindowText(hWnd, title, title.Capacity);
                uint pid;
                GetWindowThreadProcessId(hWnd, out pid);
                string process = "";
                try { process = Process.GetProcessById((int)pid).ProcessName; } catch (Exception) { }
                WindowInfo info = new WindowInfo();
                info.Handle = hWnd.ToInt64();
                info.Title = title.ToString();
                info.Process = process;
                info.Pid = (int)pid;
                info.Minimized = IsIconic(hWnd);
                result.Add(info);
                return true;
            }, IntPtr.Zero);
            return result.ToArray();
        }

        public static long Foreground()
        {
            return GetForegroundWindow().ToInt64();
        }

        public static void MediaKey(string action)
        {
            byte vk;
            switch (action)
            {
                case "play_pause": vk = 0xB3; break;
                case "next": vk = 0xB0; break;
                case "previous": vk = 0xB1; break;
                case "stop": vk = 0xB2; break;
                default: throw new ArgumentException("Unknown media action: " + action);
            }
            // KEYEVENTF_EXTENDEDKEY = 1, KEYEVENTF_KEYUP = 2
            keybd_event(vk, 0, 1, UIntPtr.Zero);
            keybd_event(vk, 0, 3, UIntPtr.Zero);
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

        private static void Focus(IntPtr hWnd)
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
