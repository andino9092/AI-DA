// Synthetic keyboard and mouse input: media keys, typing text, key combinations, clicks.
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;

namespace Aida
{
    public static class Input
    {
        [StructLayout(LayoutKind.Sequential)]
        private struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

        [StructLayout(LayoutKind.Sequential)]
        private struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

        [StructLayout(LayoutKind.Explicit)]
        private struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }

        [StructLayout(LayoutKind.Sequential)]
        private struct INPUT { public uint type; public InputUnion u; }

        [StructLayout(LayoutKind.Sequential)]
        private struct POINT { public int X; public int Y; }

        [DllImport("user32.dll", SetLastError = true)] private static extern uint SendInput(uint count, INPUT[] inputs, int size);
        [DllImport("user32.dll")] private static extern short GetAsyncKeyState(int vk);
        [DllImport("user32.dll")] private static extern bool SetCursorPos(int x, int y);
        [DllImport("user32.dll")] private static extern bool GetCursorPos(out POINT point);

        private const uint INPUT_MOUSE = 0;
        private const uint INPUT_KEYBOARD = 1;
        private const uint KEYEVENTF_EXTENDEDKEY = 0x1;
        private const uint KEYEVENTF_KEYUP = 0x2;
        private const uint KEYEVENTF_UNICODE = 0x4;
        private const uint MOUSEEVENTF_LEFTDOWN = 0x2;
        private const uint MOUSEEVENTF_LEFTUP = 0x4;
        private const uint MOUSEEVENTF_WHEEL = 0x800;

        private static readonly int[] Modifiers = { 0x10, 0x11, 0x12, 0x5B, 0x5C };
        private static readonly HashSet<int> Extended = new HashSet<int> { 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2D, 0x2E, 0x5B, 0x5C };

        private static void Send(List<INPUT> inputs)
        {
            if (inputs.Count == 0) return;
            uint sent = SendInput((uint)inputs.Count, inputs.ToArray(), Marshal.SizeOf(typeof(INPUT)));
            if (sent != inputs.Count) throw new InvalidOperationException("Windows blocked the input (an admin window may be in front).");
        }

        private static INPUT Key(int vk, bool up)
        {
            INPUT input = new INPUT();
            input.type = INPUT_KEYBOARD;
            input.u.ki.wVk = (ushort)vk;
            input.u.ki.dwFlags = (up ? KEYEVENTF_KEYUP : 0) | (Extended.Contains(vk) ? KEYEVENTF_EXTENDEDKEY : 0);
            return input;
        }

        private static INPUT Unicode(char c, bool up)
        {
            INPUT input = new INPUT();
            input.type = INPUT_KEYBOARD;
            input.u.ki.wScan = c;
            input.u.ki.dwFlags = KEYEVENTF_UNICODE | (up ? KEYEVENTF_KEYUP : 0);
            return input;
        }

        private static INPUT Mouse(uint flags, int data)
        {
            INPUT input = new INPUT();
            input.type = INPUT_MOUSE;
            input.u.mi.dwFlags = flags;
            input.u.mi.mouseData = (uint)data;
            return input;
        }

        public static void MediaKey(string action)
        {
            int vk;
            switch (action)
            {
                case "play_pause": vk = 0xB3; break;
                case "next": vk = 0xB0; break;
                case "previous": vk = 0xB1; break;
                case "stop": vk = 0xB2; break;
                default: throw new ArgumentException("Unknown media action: " + action);
            }
            Send(new List<INPUT> { Key(vk, false), Key(vk, true) });
        }

        /// <summary>Lets go of Ctrl/Alt/Shift/Win if they're held, so typed text isn't turned into shortcuts.</summary>
        public static void ReleaseModifiers()
        {
            List<INPUT> inputs = new List<INPUT>();
            foreach (int vk in Modifiers)
                if ((GetAsyncKeyState(vk) & 0x8000) != 0) inputs.Add(Key(vk, true));
            Send(inputs);
        }

        public static void TypeText(string text)
        {
            if (text.Length > 5000) throw new ArgumentException("That's too much text to type at once.");
            ReleaseModifiers();
            foreach (char c in text)
            {
                List<INPUT> inputs = new List<INPUT>();
                if (c == '\n') { inputs.Add(Key(0x0D, false)); inputs.Add(Key(0x0D, true)); }
                else if (c == '\r') continue;
                else if (c == '\t') { inputs.Add(Key(0x09, false)); inputs.Add(Key(0x09, true)); }
                else { inputs.Add(Unicode(c, false)); inputs.Add(Unicode(c, true)); }
                Send(inputs);
                // A tiny gap keeps web apps with input handlers from dropping characters.
                Thread.Sleep(2);
            }
        }

        /// <summary>"ctrl+shift+t", "enter", "alt+f4", or several separated by spaces ("ctrl+a ctrl+c").</summary>
        public static void Keys(string combos)
        {
            string[] parts = combos.Trim().ToLowerInvariant().Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length == 0 || parts.Length > 10) throw new ArgumentException("Give between 1 and 10 key combinations.");
            List<int[]> parsed = new List<int[]>();
            foreach (string part in parts) parsed.Add(ParseCombo(part));
            ReleaseModifiers();
            foreach (int[] keys in parsed)
            {
                List<INPUT> inputs = new List<INPUT>();
                foreach (int vk in keys) inputs.Add(Key(vk, false));
                for (int i = keys.Length - 1; i >= 0; i--) inputs.Add(Key(keys[i], true));
                Send(inputs);
                Thread.Sleep(30);
            }
        }

        private static int[] ParseCombo(string combo)
        {
            string[] names = combo.Split('+');
            int[] keys = new int[names.Length];
            for (int i = 0; i < names.Length; i++)
            {
                int vk = VirtualKey(names[i]);
                if (vk == 0) throw new ArgumentException("Unknown key: " + names[i]);
                keys[i] = vk;
            }
            return keys;
        }

        public static int VirtualKey(string name)
        {
            if (name.Length == 1)
            {
                char c = char.ToUpperInvariant(name[0]);
                if ((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')) return c;
            }
            if (name.Length >= 2 && name.Length <= 3 && name[0] == 'f')
            {
                int n;
                if (int.TryParse(name.Substring(1), out n) && n >= 1 && n <= 24) return 0x6F + n;
            }
            switch (name)
            {
                case "ctrl": case "control": return 0x11;
                case "alt": return 0x12;
                case "shift": return 0x10;
                case "win": case "windows": case "meta": return 0x5B;
                case "enter": case "return": return 0x0D;
                case "tab": return 0x09;
                case "esc": case "escape": return 0x1B;
                case "space": return 0x20;
                case "backspace": return 0x08;
                case "delete": case "del": return 0x2E;
                case "insert": case "ins": return 0x2D;
                case "home": return 0x24;
                case "end": return 0x23;
                case "pageup": case "pgup": return 0x21;
                case "pagedown": case "pgdn": return 0x22;
                case "up": return 0x26;
                case "down": return 0x28;
                case "left": return 0x25;
                case "right": return 0x27;
                case "plus": return 0xBB;
                case "minus": return 0xBD;
                case "comma": return 0xBC;
                case "period": return 0xBE;
                case "slash": return 0xBF;
                case "printscreen": return 0x2C;
                default: return 0;
            }
        }

        /// <summary>Clicks at a physical screen position, then puts the pointer back where it was.</summary>
        public static void Click(int x, int y, bool twice)
        {
            POINT original;
            GetCursorPos(out original);
            SetCursorPos(x, y);
            Thread.Sleep(30);
            List<INPUT> inputs = new List<INPUT> { Mouse(MOUSEEVENTF_LEFTDOWN, 0), Mouse(MOUSEEVENTF_LEFTUP, 0) };
            if (twice) { inputs.Add(Mouse(MOUSEEVENTF_LEFTDOWN, 0)); inputs.Add(Mouse(MOUSEEVENTF_LEFTUP, 0)); }
            Send(inputs);
            Thread.Sleep(120);
            SetCursorPos(original.X, original.Y);
        }

        /// <summary>Mouse wheel over a point; positive notches scroll up.</summary>
        public static void Wheel(int x, int y, int notches)
        {
            POINT original;
            GetCursorPos(out original);
            SetCursorPos(x, y);
            Thread.Sleep(30);
            Send(new List<INPUT> { Mouse(MOUSEEVENTF_WHEEL, notches * 120) });
            Thread.Sleep(60);
            SetCursorPos(original.X, original.Y);
        }
    }
}
