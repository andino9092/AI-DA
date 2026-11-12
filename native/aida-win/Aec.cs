// Echo cancellation with Windows' own Voice Capture DSP (mfwmaaec.dll, the one Windows calls use).
// It subtracts whatever the speakers play (Spotify, games, videos, Aida's own voice) from the
// microphone, so "Hey Aida" can be heard over loud music. Audio never leaves this process except
// as the cleaned 16 kHz mono stream on stdout, which goes only to AI-DA's audio window.
//
//   aida-win.exe aec-capture [--mic "<name>"]      live: raw 16-bit PCM on stdout, status on stderr
//   aida-win.exe aec-selftest <mic> <ref> <out>    files: cancels <ref>'s echo in <mic> (filter mode)
using System;
using System.IO;
using System.Media;
using System.Runtime.InteropServices;
using System.Threading;

namespace Aida
{
    [StructLayout(LayoutKind.Sequential)]
    internal struct DMO_MEDIA_TYPE
    {
        public Guid majortype;
        public Guid subtype;
        public int bFixedSizeSamples;
        public int bTemporalCompression;
        public uint lSampleSize;
        public Guid formattype;
        public IntPtr pUnk;
        public uint cbFormat;
        public IntPtr pbFormat;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct DMO_OUTPUT_DATA_BUFFER
    {
        public IntPtr pBuffer;
        public uint dwStatus;
        public long rtTimestamp;
        public long rtTimelength;
    }

    [ComImport, Guid("d8ad0f58-5494-4102-97c5-ec798e59bcf4"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMediaObject
    {
        [PreserveSig] int GetStreamCount(out uint inputs, out uint outputs);
        [PreserveSig] int GetInputStreamInfo(uint index, out uint flags);
        [PreserveSig] int GetOutputStreamInfo(uint index, out uint flags);
        [PreserveSig] int GetInputType(uint index, uint typeIndex, IntPtr type);
        [PreserveSig] int GetOutputType(uint index, uint typeIndex, IntPtr type);
        [PreserveSig] int SetInputType(uint index, ref DMO_MEDIA_TYPE type, uint flags);
        [PreserveSig] int SetOutputType(uint index, ref DMO_MEDIA_TYPE type, uint flags);
        [PreserveSig] int GetInputCurrentType(uint index, IntPtr type);
        [PreserveSig] int GetOutputCurrentType(uint index, IntPtr type);
        [PreserveSig] int GetInputSizeInfo(uint index, out uint size, out uint lookahead, out uint alignment);
        [PreserveSig] int GetOutputSizeInfo(uint index, out uint size, out uint alignment);
        [PreserveSig] int GetInputMaxLatency(uint index, out long latency);
        [PreserveSig] int SetInputMaxLatency(uint index, long latency);
        [PreserveSig] int Flush();
        [PreserveSig] int Discontinuity(uint index);
        [PreserveSig] int AllocateStreamingResources();
        [PreserveSig] int FreeStreamingResources();
        [PreserveSig] int GetInputStatus(uint index, out uint flags);
        [PreserveSig] int ProcessInput(uint index, IMediaBuffer buffer, uint flags, long timestamp, long timelength);
        [PreserveSig] int ProcessOutput(uint flags, uint count, [In, Out, MarshalAs(UnmanagedType.LPArray, SizeParamIndex = 1)] DMO_OUTPUT_DATA_BUFFER[] buffers, out uint status);
        [PreserveSig] int Lock(int lockIt);
    }

    [ComImport, Guid("59eff8b9-938c-4a26-82f2-95cb84cdc837"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMediaBuffer
    {
        [PreserveSig] int SetLength(uint length);
        [PreserveSig] int GetMaxLength(out uint length);
        [PreserveSig] int GetBufferAndLength(out IntPtr buffer, out uint length);
    }

    /// <summary>The DSP's settings. Same interface as Audio.cs's IPropertyStore, with setters.</summary>
    [ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IDspPropertyStore
    {
        [PreserveSig] int GetCount(out int count);
        [PreserveSig] int GetAt(int index, out PROPERTYKEY key);
        [PreserveSig] int GetValue(ref PROPERTYKEY key, IntPtr value);
        [PreserveSig] int SetValue(ref PROPERTYKEY key, ref DspValue value);
        [PreserveSig] int Commit();
    }

    /// <summary>A PROPVARIANT holding a VT_I4 or VT_BOOL.</summary>
    [StructLayout(LayoutKind.Explicit, Size = 24)]
    internal struct DspValue
    {
        [FieldOffset(0)] public ushort vt;
        [FieldOffset(8)] public int intValue;
        [FieldOffset(8)] public short boolValue;

        public static DspValue Int(int value) { DspValue v = new DspValue(); v.vt = 3; v.intValue = value; return v; }
        public static DspValue Bool(bool value) { DspValue v = new DspValue(); v.vt = 11; v.boolValue = (short)(value ? -1 : 0); return v; }
    }

    [ComImport, Guid("745057c7-f353-4f2d-a7ee-58434477730e")]
    internal class CWMAudioAEC
    {
    }

    /// <summary>A plain block of native memory the DSP reads from or writes into.</summary>
    [ComVisible(true), ClassInterface(ClassInterfaceType.None)]
    internal sealed class NativeBuffer : IMediaBuffer, IDisposable
    {
        public readonly IntPtr Data;
        public readonly int Capacity;
        public int Length;

        public NativeBuffer(int capacity)
        {
            Capacity = capacity;
            Data = Marshal.AllocHGlobal(capacity);
        }

        public int SetLength(uint length)
        {
            if (length > Capacity) return unchecked((int)0x80070057); // E_INVALIDARG
            Length = (int)length;
            return 0;
        }

        public int GetMaxLength(out uint length) { length = (uint)Capacity; return 0; }

        public int GetBufferAndLength(out IntPtr buffer, out uint length)
        {
            buffer = Data;
            length = (uint)Length;
            return 0;
        }

        public void Dispose() { Marshal.FreeHGlobal(Data); }
    }

    public static class Aec
    {
        private const int SampleRate = 16000;
        /// <summary>The DSP works in 10 ms frames.</summary>
        private const int FrameSamples = SampleRate / 100;
        private const uint INCOMPLETE = 0x01000000;
        private const uint TIME = 0x2;

        private static readonly Guid MEDIATYPE_Audio = new Guid("73647561-0000-0010-8000-00AA00389B71");
        private static readonly Guid MEDIASUBTYPE_PCM = new Guid("00000001-0000-0010-8000-00AA00389B71");
        private static readonly Guid FORMAT_WaveFormatEx = new Guid("05589f81-c356-11ce-bf01-00aa0055595a");
        private static readonly Guid DspKeys = new Guid("6f52c567-0360-4bd2-9617-ccbf1421c939");

        // PID_FIRST_USABLE (2) + n, from wmcodecdsp.h.
        private const int SYSTEM_MODE = 2, DMO_SOURCE_MODE = 3, DEVICE_INDEXES = 4, FEATURE_MODE = 5;
        private const int FEATR_ECHO_LENGTH = 7, FEATR_NS = 8, FEATR_AGC = 9, FEATR_AES = 10, FEATR_VAD = 11, FEATR_CENTER_CLIP = 12;
        private const int SINGLE_CHANNEL_AEC = 0;

        private static void Set(IDspPropertyStore store, int pid, DspValue value)
        {
            PROPERTYKEY key = new PROPERTYKEY { fmtid = DspKeys, pid = pid };
            Check(store.SetValue(ref key, ref value), "setting " + pid);
        }

        /// <summary>Throws with the step's name, so a failure says which call the DSP refused.</summary>
        private static void Check(int hr, string step)
        {
            if (hr >= 0) return;
            throw new InvalidOperationException(step + ": " + Marshal.GetExceptionForHR(hr).Message);
        }

        /// <summary>16 kHz, mono, 16-bit PCM.</summary>
        private static DMO_MEDIA_TYPE PcmType()
        {
            IntPtr format = Marshal.AllocHGlobal(18);
            byte[] wave = new byte[18];
            BitConverter.GetBytes((ushort)1).CopyTo(wave, 0);          // WAVE_FORMAT_PCM
            BitConverter.GetBytes((ushort)1).CopyTo(wave, 2);          // channels
            BitConverter.GetBytes(SampleRate).CopyTo(wave, 4);
            BitConverter.GetBytes(SampleRate * 2).CopyTo(wave, 8);     // bytes per second
            BitConverter.GetBytes((ushort)2).CopyTo(wave, 12);         // block align
            BitConverter.GetBytes((ushort)16).CopyTo(wave, 14);        // bits per sample
            Marshal.Copy(wave, 0, format, 18);
            return new DMO_MEDIA_TYPE
            {
                majortype = MEDIATYPE_Audio,
                subtype = MEDIASUBTYPE_PCM,
                bFixedSizeSamples = 1,
                bTemporalCompression = 0,
                lSampleSize = 2,
                formattype = FORMAT_WaveFormatEx,
                cbFormat = 18,
                pbFormat = format,
            };
        }

        /// <summary>Echo cancellation and noise suppression on; no gain control (it would change the mic volume).</summary>
        private static void ConfigureFeatures(IDspPropertyStore store)
        {
            Set(store, FEATURE_MODE, DspValue.Bool(true));
            Set(store, FEATR_AGC, DspValue.Bool(false));
            Set(store, FEATR_NS, DspValue.Int(1));
            // Two passes of echo suppression on what cancellation leaves: music is loud and wide.
            Set(store, FEATR_AES, DspValue.Int(2));
            Set(store, FEATR_CENTER_CLIP, DspValue.Bool(true));
            Set(store, FEATR_VAD, DspValue.Int(0));
            // Bluetooth speakers play 100–300 ms late: cover up to 512 ms of echo (default 256).
            Set(store, FEATR_ECHO_LENGTH, DspValue.Int(512));
        }

        /// <summary>Drains everything the DSP has ready into the callback.</summary>
        private static void Drain(IMediaObject dmo, NativeBuffer output, DMO_OUTPUT_DATA_BUFFER[] buffers, Action<byte[]> write)
        {
            do
            {
                output.Length = 0;
                buffers[0].dwStatus = 0;
                uint status;
                int hr = dmo.ProcessOutput(0, 1, buffers, out status);
                Check(hr, "output");
                if (hr == 1 || output.Length == 0) break; // S_FALSE: nothing yet
                byte[] bytes = new byte[output.Length];
                Marshal.Copy(output.Data, bytes, 0, output.Length);
                write(bytes);
            } while ((buffers[0].dwStatus & INCOMPLETE) != 0);
        }

        // ── Live capture (source mode) ───────────────────────────────────────────────────

        public static int Capture(string[] args)
        {
            string micName = null;
            for (int i = 1; i + 1 < args.Length; i++) if (args[i] == "--mic") micName = args[i + 1];

            Stream stdout = Console.OpenStandardOutput();
            TextWriter status = new StreamWriter(Console.OpenStandardError()) { AutoFlush = true };
            SoundPlayer keepAlive = null;
            try
            {
                int capture = DeviceIndex(1, micName);
                int render = DeviceIndex(0, null);

                IMediaObject dmo = (IMediaObject)new CWMAudioAEC();
                IDspPropertyStore store = (IDspPropertyStore)dmo;
                Set(store, SYSTEM_MODE, DspValue.Int(SINGLE_CHANNEL_AEC));
                Set(store, DMO_SOURCE_MODE, DspValue.Bool(true));
                Set(store, DEVICE_INDEXES, DspValue.Int((render << 16) | (capture & 0xffff)));
                ConfigureFeatures(store);
                DMO_MEDIA_TYPE type = PcmType();
                Check(dmo.SetOutputType(0, ref type, 0), "output format");
                Marshal.FreeHGlobal(type.pbFormat);
                Check(dmo.AllocateStreamingResources(), "start");

                // The DSP only runs while the speakers have an open stream: keep a silent one.
                keepAlive = new SoundPlayer(new MemoryStream(SilentWav(1)));
                keepAlive.PlayLooping();

                // Stop when AI-DA closes our stdin (or exits).
                Thread watcher = new Thread(delegate ()
                {
                    try { while (Console.In.Read() >= 0) { } } catch (Exception) { }
                    Environment.Exit(0);
                });
                watcher.IsBackground = true;
                watcher.Start();

                status.WriteLine(Json.Serializer.Serialize(Json.Obj("event", "started", "mic", capture, "speaker", render)));

                using (NativeBuffer output = new NativeBuffer(SampleRate * 2))
                {
                    DMO_OUTPUT_DATA_BUFFER[] buffers = new DMO_OUTPUT_DATA_BUFFER[1];
                    buffers[0].pBuffer = Marshal.GetComInterfaceForObject(output, typeof(IMediaBuffer));
                    while (true)
                    {
                        Drain(dmo, output, buffers, delegate (byte[] bytes)
                        {
                            stdout.Write(bytes, 0, bytes.Length);
                            stdout.Flush();
                        });
                        Thread.Sleep(10);
                    }
                }
            }
            catch (Exception e)
            {
                status.WriteLine(Json.Serializer.Serialize(Json.Obj("event", "error", "message", e.Message)));
                return 1;
            }
            finally
            {
                if (keepAlive != null) keepAlive.Stop();
            }
        }

        /// <summary>
        /// Index of a device in the active-device list (what the DSP's DEVICE_INDEXES means).
        /// flow 0 = speakers, 1 = microphones. A name picks a microphone ("Microphone (USB Audio)");
        /// otherwise the Windows default is used.
        /// </summary>
        private static int DeviceIndex(int flow, string name)
        {
            IMMDeviceEnumerator enumerator = (IMMDeviceEnumerator)new MMDeviceEnumerator();
            IMMDeviceCollection collection;
            Marshal.ThrowExceptionForHR(enumerator.EnumAudioEndpoints(flow, 1, out collection));
            int count;
            collection.GetCount(out count);
            string wanted = null;
            if (!string.IsNullOrEmpty(name))
            {
                // Chromium labels the default devices "Default - …" and "Communications - …", and
                // adds USB ids: "Microphone (2- Fifine Microphone) (3142:5060)".
                wanted = System.Text.RegularExpressions.Regex.Replace(name, "^(?:Default|Communications) - ", "");
                wanted = System.Text.RegularExpressions.Regex.Replace(wanted, @"\s*\([0-9a-fA-F]{4}:[0-9a-fA-F]{4}\)\s*$", "").Trim();
            }
            string defaultId = null;
            if (wanted == null)
            {
                IMMDevice fallback;
                // Speakers: the multimedia default (where music plays); mics: the console default.
                Marshal.ThrowExceptionForHR(enumerator.GetDefaultAudioEndpoint(flow, flow == 0 ? 1 : 0, out fallback));
                fallback.GetId(out defaultId);
            }
            for (int i = 0; i < count; i++)
            {
                IMMDevice device;
                if (collection.Item(i, out device) != 0) continue;
                if (wanted != null && string.Equals(Audio.Name(device), wanted, StringComparison.OrdinalIgnoreCase)) return i;
                string id;
                device.GetId(out id);
                if (defaultId != null && id == defaultId) return i;
            }
            if (wanted != null) return DeviceIndex(flow, null);
            throw new InvalidOperationException(flow == 0 ? "No speakers found." : "No microphone found.");
        }

        private static byte[] SilentWav(int seconds)
        {
            int dataBytes = SampleRate * 2 * seconds;
            byte[] wav = new byte[44 + dataBytes];
            System.Text.Encoding.ASCII.GetBytes("RIFF").CopyTo(wav, 0);
            BitConverter.GetBytes(36 + dataBytes).CopyTo(wav, 4);
            System.Text.Encoding.ASCII.GetBytes("WAVEfmt ").CopyTo(wav, 8);
            BitConverter.GetBytes(16).CopyTo(wav, 16);
            BitConverter.GetBytes((ushort)1).CopyTo(wav, 20);
            BitConverter.GetBytes((ushort)1).CopyTo(wav, 22);
            BitConverter.GetBytes(SampleRate).CopyTo(wav, 24);
            BitConverter.GetBytes(SampleRate * 2).CopyTo(wav, 28);
            BitConverter.GetBytes((ushort)2).CopyTo(wav, 32);
            BitConverter.GetBytes((ushort)16).CopyTo(wav, 34);
            System.Text.Encoding.ASCII.GetBytes("data").CopyTo(wav, 36);
            BitConverter.GetBytes(dataBytes).CopyTo(wav, 40);
            return wav;
        }

        // ── Self-test on files (filter mode) ─────────────────────────────────────────────

        /// <summary>
        /// Cancels the echo of <paramref name="refPath"/> (what the speakers played) in
        /// <paramref name="micPath"/> (what the mic heard). All files are raw 16 kHz mono 16-bit.
        /// Uses no audio devices, so tests can check the DSP on any Windows PC.
        /// </summary>
        public static int SelfTest(string micPath, string refPath, string outPath)
        {
            try
            {
                byte[] mic = File.ReadAllBytes(micPath);
                byte[] reference = File.ReadAllBytes(refPath);
                IMediaObject dmo = (IMediaObject)new CWMAudioAEC();
                IDspPropertyStore store = (IDspPropertyStore)dmo;
                Set(store, SYSTEM_MODE, DspValue.Int(SINGLE_CHANNEL_AEC));
                Set(store, DMO_SOURCE_MODE, DspValue.Bool(false));
                ConfigureFeatures(store);
                DMO_MEDIA_TYPE type = PcmType();
                Check(dmo.SetInputType(0, ref type, 0), "mic format");
                Check(dmo.SetInputType(1, ref type, 0), "speaker format");
                Check(dmo.SetOutputType(0, ref type, 0), "output format");
                Marshal.FreeHGlobal(type.pbFormat);
                Check(dmo.AllocateStreamingResources(), "start");

                int frameBytes = FrameSamples * 2;
                int frames = Math.Min(mic.Length, reference.Length) / frameBytes;
                using (FileStream output = File.Create(outPath))
                using (NativeBuffer micBuffer = new NativeBuffer(frameBytes))
                using (NativeBuffer refBuffer = new NativeBuffer(frameBytes))
                using (NativeBuffer outBuffer = new NativeBuffer(SampleRate * 2))
                {
                    DMO_OUTPUT_DATA_BUFFER[] buffers = new DMO_OUTPUT_DATA_BUFFER[1];
                    buffers[0].pBuffer = Marshal.GetComInterfaceForObject(outBuffer, typeof(IMediaBuffer));
                    for (int f = 0; f < frames; f++)
                    {
                        long time = (long)f * 100000; // 10 ms in 100 ns units
                        Marshal.Copy(reference, f * frameBytes, refBuffer.Data, frameBytes);
                        refBuffer.Length = frameBytes;
                        Marshal.Copy(mic, f * frameBytes, micBuffer.Data, frameBytes);
                        micBuffer.Length = frameBytes;
                        Check(dmo.ProcessInput(1, refBuffer, TIME, time, 100000), "speaker input");
                        Check(dmo.ProcessInput(0, micBuffer, TIME, time, 100000), "mic input");
                        Drain(dmo, outBuffer, buffers, delegate (byte[] bytes) { output.Write(bytes, 0, bytes.Length); });
                    }
                }
                Console.Out.WriteLine(Json.Serializer.Serialize(Json.Obj("ok", true)));
                return 0;
            }
            catch (Exception e)
            {
                Console.Out.WriteLine(Json.Serializer.Serialize(Json.Obj("ok", false, "error", e.Message)));
                return 1;
            }
        }
    }
}
