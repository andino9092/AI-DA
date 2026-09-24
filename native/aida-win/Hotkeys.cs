// Low-level keyboard hook for shortcuts that need key-up events (hold-to-talk). Matching keys are
// swallowed so the app in front doesn't also see them. Keys AI-DA types itself are ignored.
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;

namespace Aida
{
    public static class Hotkeys
    {
        private class Binding
        {
            public string Name;
            public int Vk;
            public bool Ctrl;
            public bool Alt;
            public bool Shift;
            public bool Win;
            public bool Down;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct KBDLLHOOKSTRUCT { public uint vkCode; public uint scanCode; public uint flags; public uint time; public IntPtr dwExtraInfo; }

        [StructLayout(LayoutKind.Sequential)]
        private struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public int x; public int y; }

        private delegate IntPtr LowLevelKeyboardProc(int nCode, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll", SetLastError = true)] private static extern IntPtr SetWindowsHookEx(int idHook, LowLevelKeyboardProc proc, IntPtr module, uint threadId);
        [DllImport("user32.dll")] private static extern bool UnhookWindowsHookEx(IntPtr hook);
        [DllImport("user32.dll")] private static extern IntPtr CallNextHookEx(IntPtr hook, int nCode, IntPtr wParam, IntPtr lParam);
        [DllImport("user32.dll")] private static extern int GetMessage(out MSG msg, IntPtr hWnd, uint min, uint max);
        [DllImport("user32.dll")] private static extern bool PostThreadMessage(uint threadId, uint msg, IntPtr wParam, IntPtr lParam);
        [DllImport("user32.dll")] private static extern short GetAsyncKeyState(int vk);
        [DllImport("kernel32.dll")] private static extern IntPtr GetModuleHandle(string name);
        [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();

        private const int WH_KEYBOARD_LL = 13;
        private const uint LLKHF_INJECTED = 0x10;

        private static readonly object Gate = new object();
        private static List<Binding> bindings = new List<Binding>();
        private static LowLevelKeyboardProc proc;
        private static Thread thread;
        private static uint threadId;
        private static readonly BlockingCollection<Dictionary<string, object>> Events = StartWriter();

        public static void Set(List<Dictionary<string, object>> items)
        {
            List<Binding> next = new List<Binding>();
            foreach (Dictionary<string, object> item in items)
            {
                Binding b = new Binding();
                b.Name = Json.Str(item, "name");
                b.Vk = Convert.ToInt32(item["vk"]);
                b.Ctrl = Flag(item, "ctrl");
                b.Alt = Flag(item, "alt");
                b.Shift = Flag(item, "shift");
                b.Win = Flag(item, "win");
                next.Add(b);
            }
            lock (Gate)
            {
                bindings = next;
                if (thread == null && next.Count > 0)
                {
                    thread = new Thread(Run);
                    thread.IsBackground = true;
                    thread.Start();
                }
            }
        }

        public static void Stop()
        {
            if (threadId != 0) PostThreadMessage(threadId, 0x0012 /* WM_QUIT */, IntPtr.Zero, IntPtr.Zero);
        }

        private static bool Flag(Dictionary<string, object> item, string key)
        {
            object value;
            return item.TryGetValue(key, out value) && value != null && Convert.ToBoolean(value);
        }

        private static void Run()
        {
            threadId = GetCurrentThreadId();
            proc = HookProc;
            IntPtr hook = SetWindowsHookEx(WH_KEYBOARD_LL, proc, GetModuleHandle(null), 0);
            if (hook == IntPtr.Zero)
            {
                Program.Emit(Json.Obj("event", "hotkey-error", "error", "Couldn't watch the keyboard."));
                return;
            }
            MSG msg;
            while (GetMessage(out msg, IntPtr.Zero, 0, 0) > 0) { }
            UnhookWindowsHookEx(hook);
        }

        private static bool Pressed(int vk)
        {
            return (GetAsyncKeyState(vk) & 0x8000) != 0;
        }

        private static IntPtr HookProc(int nCode, IntPtr wParam, IntPtr lParam)
        {
            if (nCode >= 0)
            {
                KBDLLHOOKSTRUCT k = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(KBDLLHOOKSTRUCT));
                if ((k.flags & LLKHF_INJECTED) == 0)
                {
                    int message = wParam.ToInt32();
                    bool down = message == 0x100 || message == 0x104;
                    bool up = message == 0x101 || message == 0x105;
                    List<Binding> current = bindings;
                    int vk = (int)k.vkCode;
                    // Letting go of Ctrl/Alt/Shift/Win also ends a held shortcut, so a missed key-up
                    // for the main key can't leave push-to-talk stuck on. The modifier's own key-up
                    // still reaches the app.
                    if (up)
                    {
                        foreach (Binding b in current)
                        {
                            if (!b.Down || !RequiresModifier(b, vk)) continue;
                            b.Down = false;
                            Notify(b.Name, false);
                        }
                    }
                    foreach (Binding b in current)
                    {
                        if (b.Vk != vk) continue;
                        if (down)
                        {
                            if (b.Down) return new IntPtr(1); // auto-repeat while held
                            bool win = Pressed(0x5B) || Pressed(0x5C);
                            if (Pressed(0x11) != b.Ctrl || Pressed(0x12) != b.Alt || Pressed(0x10) != b.Shift || win != b.Win) continue;
                            b.Down = true;
                            Notify(b.Name, true);
                            return new IntPtr(1);
                        }
                        if (up && b.Down)
                        {
                            b.Down = false;
                            Notify(b.Name, false);
                            return new IntPtr(1);
                        }
                    }
                }
            }
            return CallNextHookEx(IntPtr.Zero, nCode, wParam, lParam);
        }

        private static bool RequiresModifier(Binding b, int vk)
        {
            switch (vk)
            {
                case 0x10: case 0xA0: case 0xA1: return b.Shift;
                case 0x11: case 0xA2: case 0xA3: return b.Ctrl;
                case 0x12: case 0xA4: case 0xA5: return b.Alt;
                case 0x5B: case 0x5C: return b.Win;
                default: return false;
            }
        }

        private static void Notify(string name, bool down)
        {
            Events.Add(Json.Obj("event", "hotkey", "name", name, "down", down));
        }

        /// <summary>Hooks must return fast or Windows drops them, so events are written in order on another thread.</summary>
        private static BlockingCollection<Dictionary<string, object>> StartWriter()
        {
            BlockingCollection<Dictionary<string, object>> queue = new BlockingCollection<Dictionary<string, object>>();
            Thread writer = new Thread(delegate ()
            {
                foreach (Dictionary<string, object> e in queue.GetConsumingEnumerable()) Program.Emit(e);
            });
            writer.IsBackground = true;
            writer.Start();
            return queue;
        }
    }
}
