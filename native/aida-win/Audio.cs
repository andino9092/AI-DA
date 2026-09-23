// Core Audio: master volume and mute, per-app volume (audio sessions), and the default output
// device.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;

namespace Aida
{
    [ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IAudioEndpointVolume
    {
        [PreserveSig] int RegisterControlChangeNotify(IntPtr notify);
        [PreserveSig] int UnregisterControlChangeNotify(IntPtr notify);
        [PreserveSig] int GetChannelCount(out uint count);
        [PreserveSig] int SetMasterVolumeLevel(float levelDb, ref Guid context);
        [PreserveSig] int SetMasterVolumeLevelScalar(float level, ref Guid context);
        [PreserveSig] int GetMasterVolumeLevel(out float levelDb);
        [PreserveSig] int GetMasterVolumeLevelScalar(out float level);
        [PreserveSig] int SetChannelVolumeLevel(uint channel, float levelDb, ref Guid context);
        [PreserveSig] int SetChannelVolumeLevelScalar(uint channel, float level, ref Guid context);
        [PreserveSig] int GetChannelVolumeLevel(uint channel, out float levelDb);
        [PreserveSig] int GetChannelVolumeLevelScalar(uint channel, out float level);
        [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid context);
        [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct PROPERTYKEY { public Guid fmtid; public int pid; }

    [StructLayout(LayoutKind.Explicit, Size = 24)]
    internal struct PROPVARIANT { [FieldOffset(0)] public ushort vt; [FieldOffset(8)] public IntPtr pointer; }

    [ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IPropertyStore
    {
        [PreserveSig] int GetCount(out int count);
        [PreserveSig] int GetAt(int index, out PROPERTYKEY key);
        [PreserveSig] int GetValue(ref PROPERTYKEY key, out PROPVARIANT value);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMMDevice
    {
        [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
        [PreserveSig] int OpenPropertyStore(int access, out IPropertyStore store);
        [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
        [PreserveSig] int GetState(out int state);
    }

    [ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMMDeviceCollection
    {
        [PreserveSig] int GetCount(out int count);
        [PreserveSig] int Item(int index, out IMMDevice device);
    }

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMMDeviceEnumerator
    {
        [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection devices);
        [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
    }

    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    internal class MMDeviceEnumerator
    {
    }

    [ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IAudioSessionManager2
    {
        [PreserveSig] int GetAudioSessionControl(IntPtr sessionGuid, int flags, out IntPtr control);
        [PreserveSig] int GetSimpleAudioVolume(IntPtr sessionGuid, int flags, out IntPtr volume);
        [PreserveSig] int GetSessionEnumerator(out IAudioSessionEnumerator sessions);
    }

    [ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IAudioSessionEnumerator
    {
        [PreserveSig] int GetCount(out int count);
        [PreserveSig] int GetSession(int index, out IAudioSessionControl2 session);
    }

    [ComImport, Guid("bfb7ff88-7239-4fc9-8fa2-07c950be9c6d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IAudioSessionControl2
    {
        [PreserveSig] int GetState(out int state);
        [PreserveSig] int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string name);
        [PreserveSig] int SetDisplayName(IntPtr name, IntPtr context);
        [PreserveSig] int GetIconPath(IntPtr path);
        [PreserveSig] int SetIconPath(IntPtr path, IntPtr context);
        [PreserveSig] int GetGroupingParam(out Guid param);
        [PreserveSig] int SetGroupingParam(IntPtr param, IntPtr context);
        [PreserveSig] int RegisterAudioSessionNotification(IntPtr client);
        [PreserveSig] int UnregisterAudioSessionNotification(IntPtr client);
        [PreserveSig] int GetSessionIdentifier(IntPtr id);
        [PreserveSig] int GetSessionInstanceIdentifier(IntPtr id);
        [PreserveSig] int GetProcessId(out uint pid);
        [PreserveSig] int IsSystemSoundsSession();
    }

    [ComImport, Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface ISimpleAudioVolume
    {
        [PreserveSig] int SetMasterVolume(float level, ref Guid context);
        [PreserveSig] int GetMasterVolume(out float level);
        [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid context);
        [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
    }

    /// <summary>Undocumented but stable since Windows 7: what the Sound settings page uses to change the default device.</summary>
    [ComImport, Guid("f8679f50-850a-41cf-9c72-430f290290c8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IPolicyConfig
    {
        [PreserveSig] int GetMixFormat(IntPtr a, IntPtr b);
        [PreserveSig] int GetDeviceFormat(IntPtr a, int b, IntPtr c);
        [PreserveSig] int ResetDeviceFormat(IntPtr a);
        [PreserveSig] int SetDeviceFormat(IntPtr a, IntPtr b, IntPtr c);
        [PreserveSig] int GetProcessingPeriod(IntPtr a, int b, IntPtr c, IntPtr d);
        [PreserveSig] int SetProcessingPeriod(IntPtr a, IntPtr b);
        [PreserveSig] int GetShareMode(IntPtr a, IntPtr b);
        [PreserveSig] int SetShareMode(IntPtr a, IntPtr b);
        [PreserveSig] int GetPropertyValue(IntPtr a, IntPtr b, IntPtr c);
        [PreserveSig] int SetPropertyValue(IntPtr a, IntPtr b, IntPtr c);
        [PreserveSig] int SetDefaultEndpoint([MarshalAs(UnmanagedType.LPWStr)] string deviceId, int role);
        [PreserveSig] int SetEndpointVisibility(IntPtr a, int b);
    }

    [ComImport, Guid("870af99c-171d-4f9e-af0d-e63df40c2bc9")]
    internal class PolicyConfigClient
    {
    }

    public static class Audio
    {
        [DllImport("ole32.dll")] private static extern int PropVariantClear(ref PROPVARIANT value);

        private const int CLSCTX_ALL = 23;
        private const int DEVICE_STATE_ACTIVE = 1;

        private static IMMDevice DefaultDevice()
        {
            IMMDeviceEnumerator enumerator = (IMMDeviceEnumerator)new MMDeviceEnumerator();
            IMMDevice device;
            // eRender = 0, eMultimedia = 1
            Marshal.ThrowExceptionForHR(enumerator.GetDefaultAudioEndpoint(0, 1, out device));
            return device;
        }

        private static T Activate<T>(IMMDevice device)
        {
            Guid iid = typeof(T).GUID;
            object result;
            Marshal.ThrowExceptionForHR(device.Activate(ref iid, CLSCTX_ALL, IntPtr.Zero, out result));
            return (T)result;
        }

        private static IAudioEndpointVolume Endpoint()
        {
            return Activate<IAudioEndpointVolume>(DefaultDevice());
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

        public static Dictionary<string, object> State()
        {
            return Json.Obj("level", GetVolume(), "muted", GetMute());
        }

        public static bool SetMute(bool mute)
        {
            Guid context = Guid.Empty;
            Marshal.ThrowExceptionForHR(Endpoint().SetMute(mute, ref context));
            return GetMute();
        }

        // ── Per-app volume ────────────────────────────────────────────────────────────────

        private static List<KeyValuePair<string, ISimpleAudioVolume>> Sessions()
        {
            List<KeyValuePair<string, ISimpleAudioVolume>> result = new List<KeyValuePair<string, ISimpleAudioVolume>>();
            IAudioSessionManager2 manager = Activate<IAudioSessionManager2>(DefaultDevice());
            IAudioSessionEnumerator sessions;
            Marshal.ThrowExceptionForHR(manager.GetSessionEnumerator(out sessions));
            int count;
            sessions.GetCount(out count);
            for (int i = 0; i < count; i++)
            {
                IAudioSessionControl2 session;
                if (sessions.GetSession(i, out session) != 0) continue;
                if (session.IsSystemSoundsSession() == 0) continue; // S_OK means it is system sounds
                uint pid;
                session.GetProcessId(out pid);
                string process = "";
                try { process = Process.GetProcessById((int)pid).ProcessName; } catch (Exception) { continue; }
                result.Add(new KeyValuePair<string, ISimpleAudioVolume>(process, (ISimpleAudioVolume)session));
            }
            return result;
        }

        /// <summary>Apps that currently have an audio session, one entry per process name.</summary>
        public static List<Dictionary<string, object>> Apps()
        {
            Dictionary<string, Dictionary<string, object>> byName = new Dictionary<string, Dictionary<string, object>>(StringComparer.OrdinalIgnoreCase);
            foreach (KeyValuePair<string, ISimpleAudioVolume> s in Sessions())
            {
                if (byName.ContainsKey(s.Key)) continue;
                float level;
                bool muted;
                s.Value.GetMasterVolume(out level);
                s.Value.GetMute(out muted);
                byName[s.Key] = Json.Obj("process", s.Key, "level", (int)Math.Round(level * 100), "muted", muted);
            }
            return new List<Dictionary<string, object>>(byName.Values);
        }

        /// <summary>Sets volume and/or mute for every session of a process (apps often have several).</summary>
        public static Dictionary<string, object> SetApp(string process, int level, int muted)
        {
            Guid context = Guid.Empty;
            bool found = false;
            foreach (KeyValuePair<string, ISimpleAudioVolume> s in Sessions())
            {
                if (!string.Equals(s.Key, process, StringComparison.OrdinalIgnoreCase)) continue;
                found = true;
                if (level >= 0) s.Value.SetMasterVolume(Math.Max(0, Math.Min(100, level)) / 100f, ref context);
                if (muted >= 0) s.Value.SetMute(muted == 1, ref context);
            }
            if (!found) throw new ArgumentException("NO_AUDIO:" + process);
            foreach (Dictionary<string, object> app in Apps())
                if (string.Equals((string)app["process"], process, StringComparison.OrdinalIgnoreCase)) return app;
            return Json.Obj("process", process);
        }

        // ── Output devices ───────────────────────────────────────────────────────────────

        private static readonly PROPERTYKEY FriendlyName = new PROPERTYKEY
        {
            fmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"),
            pid = 14
        };

        private static string Name(IMMDevice device)
        {
            IPropertyStore store;
            if (device.OpenPropertyStore(0, out store) != 0) return "";
            PROPERTYKEY key = FriendlyName;
            PROPVARIANT value;
            if (store.GetValue(ref key, out value) != 0) return "";
            string name = value.vt == 31 ? Marshal.PtrToStringUni(value.pointer) : "";
            PropVariantClear(ref value);
            return name ?? "";
        }

        public static List<Dictionary<string, object>> Devices()
        {
            IMMDeviceEnumerator enumerator = (IMMDeviceEnumerator)new MMDeviceEnumerator();
            string defaultId;
            DefaultDevice().GetId(out defaultId);
            IMMDeviceCollection collection;
            Marshal.ThrowExceptionForHR(enumerator.EnumAudioEndpoints(0, DEVICE_STATE_ACTIVE, out collection));
            int count;
            collection.GetCount(out count);
            List<Dictionary<string, object>> result = new List<Dictionary<string, object>>();
            for (int i = 0; i < count; i++)
            {
                IMMDevice device;
                if (collection.Item(i, out device) != 0) continue;
                string id;
                device.GetId(out id);
                result.Add(Json.Obj("id", id, "name", Name(device), "default", id == defaultId));
            }
            return result;
        }

        public static bool SetDefaultDevice(string id)
        {
            bool known = false;
            foreach (Dictionary<string, object> d in Devices()) if ((string)d["id"] == id) known = true;
            if (!known) throw new ArgumentException("That audio device isn't connected.");
            IPolicyConfig policy = (IPolicyConfig)new PolicyConfigClient();
            // Console, multimedia and communications roles, like the Sound settings page does.
            for (int role = 0; role < 3; role++) Marshal.ThrowExceptionForHR(policy.SetDefaultEndpoint(id, role));
            return true;
        }
    }
}
