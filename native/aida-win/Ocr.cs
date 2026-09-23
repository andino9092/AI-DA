// Windows OCR (on-device) for apps whose buttons UI Automation can't see, like games or canvas
// apps. The screenshot stays in memory in this process; only recognized text is returned.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using Windows.Graphics.Imaging;
using Windows.Media.Ocr;
using Windows.Security.Cryptography;

namespace Aida
{
    public static class Ocr
    {
        public static Dictionary<string, object> Window(long handle)
        {
            IntPtr hWnd = new IntPtr(handle);
            Win.RECT r = Win.Bounds(hWnd);
            int width = r.Right - r.Left;
            int height = r.Bottom - r.Top;
            if (width <= 0 || height <= 0) throw new InvalidOperationException("That window isn't visible.");

            OcrEngine engine = OcrEngine.TryCreateFromUserProfileLanguages();
            if (engine == null) throw new InvalidOperationException("Windows text recognition isn't installed for your language.");

            // Downscale very large windows to what the engine accepts.
            double scale = Math.Min(1.0, (double)OcrEngine.MaxImageDimension / Math.Max(width, height));
            int w = (int)(width * scale);
            int h = (int)(height * scale);

            byte[] pixels = new byte[w * h * 4];
            using (Bitmap capture = new Bitmap(width, height, PixelFormat.Format32bppPArgb))
            {
                using (Graphics g = Graphics.FromImage(capture))
                    g.CopyFromScreen(r.Left, r.Top, 0, 0, new Size(width, height), CopyPixelOperation.SourceCopy);
                Bitmap source = capture;
                Bitmap scaled = null;
                if (scale < 1.0) { scaled = new Bitmap(capture, new Size(w, h)); source = scaled; }
                try
                {
                    BitmapData data = source.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.ReadOnly, PixelFormat.Format32bppPArgb);
                    try
                    {
                        for (int y = 0; y < h; y++)
                            Marshal.Copy(IntPtr.Add(data.Scan0, y * data.Stride), pixels, y * w * 4, w * 4);
                    }
                    finally { source.UnlockBits(data); }
                }
                finally { if (scaled != null) scaled.Dispose(); }
            }

            SoftwareBitmap bitmap = SoftwareBitmap.CreateCopyFromBuffer(
                CryptographicBuffer.CreateFromByteArray(pixels), BitmapPixelFormat.Bgra8, w, h, BitmapAlphaMode.Premultiplied);
            OcrResult result = WinRt.Await(engine.RecognizeAsync(bitmap), 10000);
            Array.Clear(pixels, 0, pixels.Length);

            List<Dictionary<string, object>> lines = new List<Dictionary<string, object>>();
            foreach (OcrLine line in result.Lines)
            {
                List<Dictionary<string, object>> words = new List<Dictionary<string, object>>();
                foreach (OcrWord word in line.Words)
                {
                    Windows.Foundation.Rect b = word.BoundingRect;
                    words.Add(Json.Obj(
                        "text", word.Text,
                        "x", r.Left + (int)(b.X / scale),
                        "y", r.Top + (int)(b.Y / scale),
                        "w", (int)(b.Width / scale),
                        "h", (int)(b.Height / scale)));
                }
                lines.Add(Json.Obj("text", line.Text, "words", words));
            }
            return Json.Obj("lines", lines);
        }
    }
}
