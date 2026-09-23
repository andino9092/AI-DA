// Windows media sessions (the same ones the volume flyout shows): what's playing in each app, and
// explicit play / pause / next / previous for a specific app instead of the play/pause toggle key.
using System;
using System.Collections.Generic;
using System.Threading;
using Windows.Foundation;
using Windows.Media.Control;

namespace Aida
{
    public static class WinRt
    {
        /// <summary>Blocks on a WinRT async call (the usual AsTask helpers need the Windows SDK).</summary>
        public static T Await<T>(IAsyncOperation<T> operation, int timeoutMs)
        {
            ManualResetEvent done = new ManualResetEvent(false);
            operation.Completed = delegate { done.Set(); };
            if (!done.WaitOne(timeoutMs)) throw new TimeoutException("Windows took too long to answer.");
            if (operation.Status == AsyncStatus.Error) throw operation.ErrorCode;
            if (operation.Status == AsyncStatus.Canceled) throw new OperationCanceledException();
            return operation.GetResults();
        }
    }

    public static class Media
    {
        private static readonly object Gate = new object();
        private static GlobalSystemMediaTransportControlsSessionManager manager;

        private static GlobalSystemMediaTransportControlsSessionManager Manager()
        {
            lock (Gate)
            {
                if (manager == null) manager = WinRt.Await(GlobalSystemMediaTransportControlsSessionManager.RequestAsync(), 5000);
                return manager;
            }
        }

        public static List<Dictionary<string, object>> Sessions()
        {
            GlobalSystemMediaTransportControlsSessionManager mgr = Manager();
            GlobalSystemMediaTransportControlsSession current = mgr.GetCurrentSession();
            List<Dictionary<string, object>> result = new List<Dictionary<string, object>>();
            foreach (GlobalSystemMediaTransportControlsSession session in mgr.GetSessions())
                result.Add(Describe(session, current));
            return result;
        }

        public static Dictionary<string, object> Control(string action, string app)
        {
            GlobalSystemMediaTransportControlsSessionManager mgr = Manager();
            GlobalSystemMediaTransportControlsSession session = Pick(mgr, action, app);
            if (session == null)
            {
                if (app != null) throw new InvalidOperationException("NO_SESSION:" + app);
                throw new InvalidOperationException("NO_SESSION");
            }

            IAsyncOperation<bool> operation;
            int settleMs = 300;
            switch (action)
            {
                case "play": operation = session.TryPlayAsync(); break;
                case "pause": operation = session.TryPauseAsync(); break;
                case "toggle": operation = session.TryTogglePlayPauseAsync(); break;
                case "next": operation = session.TrySkipNextAsync(); settleMs = 900; break;
                case "previous": operation = session.TrySkipPreviousAsync(); settleMs = 900; break;
                case "stop": operation = session.TryStopAsync(); break;
                default: throw new ArgumentException("Unknown media action: " + action);
            }
            bool accepted = WinRt.Await(operation, 5000);
            // Give the app a moment to update its state and track info before reporting it.
            Thread.Sleep(settleMs);
            Dictionary<string, object> state = Describe(session, mgr.GetCurrentSession());
            state["accepted"] = accepted;
            return state;
        }

        /// <summary>
        /// Which app a command is for: the named one, else the one playing (for pause/next), else
        /// the one Windows considers current, else a paused one (for play).
        /// </summary>
        private static GlobalSystemMediaTransportControlsSession Pick(GlobalSystemMediaTransportControlsSessionManager mgr, string action, string app)
        {
            List<GlobalSystemMediaTransportControlsSession> sessions = new List<GlobalSystemMediaTransportControlsSession>(mgr.GetSessions());
            if (app != null)
            {
                string wanted = app.ToLowerInvariant();
                foreach (GlobalSystemMediaTransportControlsSession s in sessions)
                    if (s.SourceAppUserModelId.ToLowerInvariant().Contains(wanted)) return s;
                return null;
            }

            GlobalSystemMediaTransportControlsSession current = mgr.GetCurrentSession();
            GlobalSystemMediaTransportControlsSessionPlaybackStatus preferred = action == "play"
                ? GlobalSystemMediaTransportControlsSessionPlaybackStatus.Paused
                : GlobalSystemMediaTransportControlsSessionPlaybackStatus.Playing;
            if (current != null && Status(current) == preferred) return current;
            foreach (GlobalSystemMediaTransportControlsSession s in sessions)
                if (Status(s) == preferred) return s;
            if (current != null) return current;
            return sessions.Count > 0 ? sessions[0] : null;
        }

        private static GlobalSystemMediaTransportControlsSessionPlaybackStatus Status(GlobalSystemMediaTransportControlsSession session)
        {
            try { return session.GetPlaybackInfo().PlaybackStatus; }
            catch (Exception) { return GlobalSystemMediaTransportControlsSessionPlaybackStatus.Closed; }
        }

        private static Dictionary<string, object> Describe(GlobalSystemMediaTransportControlsSession session, GlobalSystemMediaTransportControlsSession current)
        {
            string title = "";
            string artist = "";
            try
            {
                GlobalSystemMediaTransportControlsSessionMediaProperties props = WinRt.Await(session.TryGetMediaPropertiesAsync(), 2000);
                title = props.Title ?? "";
                artist = props.Artist ?? "";
            }
            catch (Exception) { }
            string appId = session.SourceAppUserModelId ?? "";
            return Json.Obj(
                "appId", appId,
                "status", Status(session).ToString().ToLowerInvariant(),
                "title", title,
                "artist", artist,
                "current", current != null && current.SourceAppUserModelId == appId);
        }
    }
}
