// AI-DA's Windows helper. Compiled at build time by the C# compiler that ships with Windows
// (.NET Framework 4.8, C# 5 syntax: no string interpolation, `?.`, or expression-bodied members).
//
// Protocol: one JSON request per line on stdin ({"id":1,"cmd":"volume.get","args":{}}), one JSON
// response per line on stdout ({"id":1,"ok":true,"result":...}). Unrequested events (hotkeys) are
// lines like {"event":"hotkey",...}. Only the commands in Dispatch can run. Exits when stdin closes.
using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

namespace Aida
{
    public static class Program
    {
        private static readonly object OutLock = new object();
        private static TextWriter output;

        [MTAThread]
        public static int Main()
        {
            Console.InputEncoding = new UTF8Encoding(false);
            output = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
            Win.Init();
            Emit(Json.Obj("ready", true));

            string line;
            while ((line = Console.In.ReadLine()) != null)
            {
                string request = line.TrimStart('﻿').Trim();
                if (request.Length == 0) continue;
                // Each request runs on its own worker so a slow UI scan doesn't hold up volume keys.
                ThreadPool.QueueUserWorkItem(delegate { Handle(request); });
            }
            Hotkeys.Stop();
            return 0;
        }

        public static void Emit(object message)
        {
            string text = Json.Serializer.Serialize(message);
            lock (OutLock)
            {
                output.Write(text);
                output.Write('\n');
                output.Flush();
            }
        }

        private static void Handle(string line)
        {
            object id = null;
            try
            {
                Dictionary<string, object> request = Json.Serializer.Deserialize<Dictionary<string, object>>(line);
                request.TryGetValue("id", out id);
                object rawArgs;
                request.TryGetValue("args", out rawArgs);
                Args args = new Args(rawArgs as Dictionary<string, object>);
                object result = Dispatch(Json.Str(request, "cmd"), args);
                Emit(Json.Obj("id", id, "ok", true, "result", result));
            }
            catch (Exception e)
            {
                Exception inner = e;
                while (inner is System.Reflection.TargetInvocationException && inner.InnerException != null) inner = inner.InnerException;
                Emit(Json.Obj("id", id, "ok", false, "error", inner.Message));
            }
        }

        private static object Dispatch(string cmd, Args a)
        {
            switch (cmd)
            {
                case "ping": return "pong";

                case "volume.get": return Audio.State();
                case "volume.set": Audio.SetVolume(a.Int("level")); return Audio.State();
                case "mute.set": Audio.SetMute(a.Bool("muted")); return Audio.State();
                case "audio.apps": return Audio.Apps();
                case "audio.app.set":
                    return Audio.SetApp(a.Str("process"), a.OptInt("level", -1), a.OptStr("muted") == null ? -1 : (a.Bool("muted") ? 1 : 0));
                case "audio.devices": return Audio.Devices();
                case "audio.device.set": return Audio.SetDefaultDevice(a.Str("id"));

                case "media.key": Input.MediaKey(a.Str("action")); return true;
                case "media.sessions": return Media.Sessions();
                case "media.control": return Media.Control(a.Str("action"), a.OptStr("app"));

                case "windows.list": return Win.List();
                case "windows.foreground": return Win.Foreground();
                case "windows.info": return Win.Info(a.Long("handle"));
                case "windows.act": return Win.Act(a.Long("handle"), a.Str("action"));

                case "apps.list": return Apps.List();

                case "ui.snapshot": return Ui.Snapshot(a.Long("handle"), a.OptInt("max", 250));
                case "ui.click": return Ui.Click(a.Int("id"));
                case "ui.focus": return Ui.Focus(a.Int("id"));
                case "ui.scroll": return Ui.Scroll(a.Long("handle"), a.Str("direction"), a.OptInt("amount", 5));

                case "input.type": Input.TypeText(a.Str("text")); return true;
                case "input.keys": Input.Keys(a.Str("keys")); return true;
                case "input.click": Input.Click(a.Int("x"), a.Int("y"), a.OptBool("double", false)); return true;
                case "input.release": Input.ReleaseModifiers(); return true;

                case "ocr.window": return Ocr.Window(a.Long("handle"));

                case "hotkeys.set": Hotkeys.Set(a.List("bindings")); return true;

                default: throw new ArgumentException("Unknown command: " + cmd);
            }
        }
    }

    /// <summary>Typed access to a request's "args" object.</summary>
    public class Args
    {
        private readonly Dictionary<string, object> values;

        public Args(Dictionary<string, object> values)
        {
            this.values = values ?? new Dictionary<string, object>();
        }

        private object Get(string key)
        {
            object value;
            if (!values.TryGetValue(key, out value) || value == null) throw new ArgumentException("Missing argument: " + key);
            return value;
        }

        public string Str(string key) { return Convert.ToString(Get(key)); }
        public int Int(string key) { return Convert.ToInt32(Get(key)); }
        public long Long(string key) { return Convert.ToInt64(Get(key)); }
        public bool Bool(string key) { return Convert.ToBoolean(Get(key)); }

        public string OptStr(string key)
        {
            object value;
            return values.TryGetValue(key, out value) && value != null ? Convert.ToString(value) : null;
        }

        public int OptInt(string key, int fallback)
        {
            object value;
            return values.TryGetValue(key, out value) && value != null ? Convert.ToInt32(value) : fallback;
        }

        public bool OptBool(string key, bool fallback)
        {
            object value;
            return values.TryGetValue(key, out value) && value != null ? Convert.ToBoolean(value) : fallback;
        }

        public List<Dictionary<string, object>> List(string key)
        {
            List<Dictionary<string, object>> result = new List<Dictionary<string, object>>();
            System.Collections.IEnumerable items = Get(key) as System.Collections.IEnumerable;
            if (items == null) throw new ArgumentException(key + " must be a list");
            foreach (object item in items)
            {
                Dictionary<string, object> entry = item as Dictionary<string, object>;
                if (entry != null) result.Add(entry);
            }
            return result;
        }
    }

    public static class Json
    {
        public static readonly JavaScriptSerializer Serializer = CreateSerializer();

        private static JavaScriptSerializer CreateSerializer()
        {
            JavaScriptSerializer serializer = new JavaScriptSerializer();
            serializer.MaxJsonLength = 32 * 1024 * 1024;
            return serializer;
        }

        /// <summary>Json.Obj("a", 1, "b", 2) → {"a":1,"b":2}.</summary>
        public static Dictionary<string, object> Obj(params object[] pairs)
        {
            Dictionary<string, object> result = new Dictionary<string, object>();
            for (int i = 0; i + 1 < pairs.Length; i += 2) result[(string)pairs[i]] = pairs[i + 1];
            return result;
        }

        public static string Str(Dictionary<string, object> map, string key)
        {
            object value;
            return map.TryGetValue(key, out value) && value != null ? Convert.ToString(value) : "";
        }
    }
}
