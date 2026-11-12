// Whether now is a good moment to talk to the user: full-screen app or game, another app using
// the microphone (a call), and how long since the last keyboard or mouse input.
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using Microsoft.Win32;

namespace Aida
{
    public static class Presence
    {
        [DllImport("shell32.dll")]
        private static extern int SHQueryUserNotificationState(out int state);

        [StructLayout(LayoutKind.Sequential)]
        private struct LastInputInfo
        {
            public uint cbSize;
            public uint dwTime;
        }

        [DllImport("user32.dll")]
        private static extern bool GetLastInputInfo(ref LastInputInfo info);

        private const string MicStore =
            @"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone";

        public static object Get()
        {
            // QUERY_USER_NOTIFICATION_STATE: 1 locked or screen saver, 2 full-screen app, 3 full-screen
            // Direct3D game, 4 presentation mode, 5 free, 6 quiet time after setup, 7 full-screen Store app.
            int state;
            if (SHQueryUserNotificationState(out state) != 0) state = 0;

            LastInputInfo info = new LastInputInfo();
            info.cbSize = (uint)Marshal.SizeOf(typeof(LastInputInfo));
            long idleMs = 0;
            if (GetLastInputInfo(ref info)) idleMs = unchecked((uint)Environment.TickCount - info.dwTime);

            return Json.Obj("notificationState", state, "idleSeconds", idleMs / 1000, "micApps", MicApps());
        }

        /// <summary>
        /// Apps using the microphone right now, as Windows' privacy settings record them: a Store app
        /// id, or an exe path for desktop apps ("C:#Program Files#Discord#Discord.exe").
        /// </summary>
        private static List<string> MicApps()
        {
            List<string> apps = new List<string>();
            using (RegistryKey store = Registry.CurrentUser.OpenSubKey(MicStore))
            {
                if (store == null) return apps;
                foreach (string name in store.GetSubKeyNames())
                {
                    using (RegistryKey key = store.OpenSubKey(name))
                    {
                        if (key == null) continue;
                        if (name == "NonPackaged")
                        {
                            foreach (string exe in key.GetSubKeyNames())
                            {
                                using (RegistryKey app = key.OpenSubKey(exe))
                                {
                                    if (InUse(app)) apps.Add(exe);
                                }
                            }
                        }
                        else if (InUse(key)) apps.Add(name);
                    }
                }
            }
            return apps;
        }

        /// <summary>Started using the mic and hasn't stopped (the stop time is 0 while in use).</summary>
        private static bool InUse(RegistryKey key)
        {
            if (key == null) return false;
            object start = key.GetValue("LastUsedTimeStart");
            object stop = key.GetValue("LastUsedTimeStop");
            return start is long && (long)start != 0 && stop is long && (long)stop == 0;
        }
    }
}
