// UI Automation: lists the buttons, fields and links in a window and acts on them by id.
// Password fields are reported as such but their contents are never read.
using System;
using System.Collections.Generic;
using System.Threading;
using System.Windows;
using System.Windows.Automation;

namespace Aida
{
    public static class Ui
    {
        private static readonly object Gate = new object();
        private static Dictionary<int, AutomationElement> elements = new Dictionary<int, AutomationElement>();

        private static readonly HashSet<ControlType> Actionable = new HashSet<ControlType>
        {
            ControlType.Button, ControlType.SplitButton, ControlType.MenuItem, ControlType.Hyperlink,
            ControlType.Edit, ControlType.Document, ControlType.CheckBox, ControlType.RadioButton,
            ControlType.ComboBox, ControlType.ListItem, ControlType.TabItem, ControlType.TreeItem,
            ControlType.Slider, ControlType.Spinner, ControlType.DataItem, ControlType.MenuBar
        };

        private const int MaxTextElements = 80;
        private const int MaxNameLength = 100;
        private const int MaxValueLength = 80;

        public static Dictionary<string, object> Snapshot(long handle, int max)
        {
            lock (Gate)
            {
                IntPtr hWnd = new IntPtr(handle);
                AutomationElement root = AutomationElement.FromHandle(hWnd);

                AutomationElementCollection found = Find(root);
                // Chromium-based apps (Discord, Spotify, browsers) build their accessibility tree
                // only once a screen reader-like client asks, so the first look can come back thin.
                if (found.Count < 8)
                {
                    Thread.Sleep(600);
                    found = Find(root);
                }

                elements = new Dictionary<int, AutomationElement>();
                List<Dictionary<string, object>> list = new List<Dictionary<string, object>>();
                int texts = 0;
                bool truncated = false;
                foreach (AutomationElement el in found)
                {
                    ControlType type = (ControlType)el.GetCachedPropertyValue(AutomationElement.ControlTypeProperty);
                    string name = Clip((string)el.GetCachedPropertyValue(AutomationElement.NameProperty), MaxNameLength);
                    Rect box = (Rect)el.GetCachedPropertyValue(AutomationElement.BoundingRectangleProperty);
                    if (box.IsEmpty || box.Width < 1 || box.Height < 1) continue;

                    bool isText = type == ControlType.Text;
                    if (!isText && !Actionable.Contains(type)) continue;
                    if (isText && (name.Length == 0 || texts >= MaxTextElements)) continue;
                    if (list.Count >= max) { truncated = true; break; }
                    if (isText) texts++;

                    int id = list.Count + 1;
                    elements[id] = el;
                    Dictionary<string, object> item = Json.Obj(
                        "id", id,
                        "role", Role(type),
                        "name", name,
                        "enabled", (bool)el.GetCachedPropertyValue(AutomationElement.IsEnabledProperty),
                        "x", (int)box.X, "y", (int)box.Y, "w", (int)box.Width, "h", (int)box.Height);

                    bool password = (bool)el.GetCachedPropertyValue(AutomationElement.IsPasswordProperty);
                    if (password) item["password"] = true;
                    else if (type == ControlType.Edit || type == ControlType.ComboBox)
                    {
                        object value = el.GetCachedPropertyValue(ValuePattern.ValueProperty, true);
                        string text = value as string;
                        if (!string.IsNullOrEmpty(text)) item["value"] = Clip(text, MaxValueLength);
                    }
                    if ((bool)el.GetCachedPropertyValue(AutomationElement.HasKeyboardFocusProperty)) item["focused"] = true;
                    list.Add(item);
                }

                return Json.Obj(
                    "window", Json.Obj("title", Win.Title(hWnd), "process", Win.ProcessName(hWnd)),
                    "elements", list,
                    "truncated", truncated);
            }
        }

        private static AutomationElementCollection Find(AutomationElement root)
        {
            CacheRequest cache = new CacheRequest();
            cache.AutomationElementMode = AutomationElementMode.Full;
            cache.TreeFilter = Automation.ControlViewCondition;
            cache.Add(AutomationElement.NameProperty);
            cache.Add(AutomationElement.ControlTypeProperty);
            cache.Add(AutomationElement.BoundingRectangleProperty);
            cache.Add(AutomationElement.IsEnabledProperty);
            cache.Add(AutomationElement.IsPasswordProperty);
            cache.Add(AutomationElement.HasKeyboardFocusProperty);
            cache.Add(ValuePattern.ValueProperty);
            using (cache.Activate())
            {
                Condition visible = new AndCondition(
                    Automation.ControlViewCondition,
                    new PropertyCondition(AutomationElement.IsOffscreenProperty, false));
                return root.FindAll(TreeScope.Descendants, visible);
            }
        }

        private static string Role(ControlType type)
        {
            string name = type.ProgrammaticName; // "ControlType.Button"
            int dot = name.LastIndexOf('.');
            return (dot >= 0 ? name.Substring(dot + 1) : name).ToLowerInvariant();
        }

        private static string Clip(string text, int max)
        {
            if (text == null) return "";
            text = text.Replace('\n', ' ').Replace('\r', ' ').Trim();
            return text.Length <= max ? text : text.Substring(0, max) + "…";
        }

        private static AutomationElement Get(int id)
        {
            AutomationElement el;
            lock (Gate)
            {
                if (!elements.TryGetValue(id, out el)) throw new ArgumentException("STALE: I need to look at the window again.");
            }
            return el;
        }

        /// <summary>Uses the control's own action when it has one (works even if covered), else a real click.</summary>
        public static Dictionary<string, object> Click(int id)
        {
            AutomationElement el = Get(id);
            try
            {
                object pattern;
                if (el.TryGetCurrentPattern(InvokePattern.Pattern, out pattern))
                {
                    InvokePattern invoke = (InvokePattern)pattern;
                    // Invoke can block until a dialog it opens is closed, so don't wait on it for long.
                    Thread worker = new Thread(delegate () { try { invoke.Invoke(); } catch (Exception) { } });
                    worker.IsBackground = true;
                    worker.Start();
                    worker.Join(1500);
                    return Json.Obj("method", "invoke");
                }
                if (el.TryGetCurrentPattern(TogglePattern.Pattern, out pattern))
                {
                    ((TogglePattern)pattern).Toggle();
                    return Json.Obj("method", "toggle");
                }
                if (el.TryGetCurrentPattern(SelectionItemPattern.Pattern, out pattern))
                {
                    ((SelectionItemPattern)pattern).Select();
                    return Json.Obj("method", "select");
                }
                if (el.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out pattern))
                {
                    ExpandCollapsePattern expand = (ExpandCollapsePattern)pattern;
                    if (expand.Current.ExpandCollapseState == ExpandCollapseState.Expanded) expand.Collapse();
                    else expand.Expand();
                    return Json.Obj("method", "expand");
                }
                Rect box = el.Current.BoundingRectangle;
                if (box.IsEmpty) throw new InvalidOperationException("That control isn't on screen.");
                FocusTopWindow(el);
                Input.Click((int)(box.X + box.Width / 2), (int)(box.Y + box.Height / 2), false);
                return Json.Obj("method", "mouse");
            }
            catch (ElementNotAvailableException)
            {
                throw new ArgumentException("STALE: That control is gone. I need to look at the window again.");
            }
        }

        public static bool Focus(int id)
        {
            AutomationElement el = Get(id);
            try
            {
                FocusTopWindow(el);
                el.SetFocus();
                return true;
            }
            catch (ElementNotAvailableException)
            {
                throw new ArgumentException("STALE: That control is gone. I need to look at the window again.");
            }
        }

        private static void FocusTopWindow(AutomationElement el)
        {
            TreeWalker walker = TreeWalker.ControlViewWalker;
            AutomationElement node = el;
            AutomationElement top = el;
            while (node != null && node != AutomationElement.RootElement)
            {
                top = node;
                node = walker.GetParent(node);
            }
            int handle = top.Current.NativeWindowHandle;
            if (handle != 0 && !Win.IsForeground(new IntPtr(handle))) Win.Focus(new IntPtr(handle));
        }

        /// <summary>Scrolls the window's main scrollable area, falling back to the mouse wheel.</summary>
        public static bool Scroll(long handle, string direction, int amount)
        {
            IntPtr hWnd = new IntPtr(handle);
            bool down = direction == "down";
            if (!down && direction != "up") throw new ArgumentException("Scroll up or down.");
            amount = Math.Max(1, Math.Min(20, amount));
            try
            {
                AutomationElement root = AutomationElement.FromHandle(hWnd);
                AutomationElement area = root.FindFirst(TreeScope.Descendants, new AndCondition(
                    new PropertyCondition(AutomationElement.IsScrollPatternAvailableProperty, true),
                    new PropertyCondition(AutomationElement.IsOffscreenProperty, false)));
                if (area != null)
                {
                    ScrollPattern scroll = (ScrollPattern)area.GetCurrentPattern(ScrollPattern.Pattern);
                    if (scroll.Current.VerticallyScrollable)
                    {
                        for (int i = 0; i < amount; i++)
                            scroll.ScrollVertical(down ? ScrollAmount.SmallIncrement : ScrollAmount.SmallDecrement);
                        return true;
                    }
                }
            }
            catch (Exception) { }
            Win.RECT r = Win.Bounds(hWnd);
            Input.Wheel((r.Left + r.Right) / 2, (r.Top + r.Bottom) / 2, down ? -amount : amount);
            return true;
        }
    }
}
