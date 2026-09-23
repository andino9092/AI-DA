// The Start menu's app list (desktop and Store apps), the same list Get-StartApps returns.
using System;
using System.Collections.Generic;
using System.Threading;

namespace Aida
{
    public static class Apps
    {
        private const string AppsFolder = "shell:::{4234d49b-0245-4df3-b780-3893943456e1}";

        public static List<Dictionary<string, object>> List()
        {
            List<Dictionary<string, object>> result = new List<Dictionary<string, object>>();
            Exception failure = null;
            // The Shell's COM objects expect a single-threaded apartment.
            Thread thread = new Thread(delegate ()
            {
                try
                {
                    dynamic shell = Activator.CreateInstance(Type.GetTypeFromProgID("Shell.Application"));
                    dynamic folder = shell.NameSpace(AppsFolder);
                    foreach (dynamic item in folder.Items())
                    {
                        string name = item.Name;
                        string appId = item.Path;
                        if (!string.IsNullOrEmpty(name) && !string.IsNullOrEmpty(appId))
                            result.Add(Json.Obj("name", name, "appId", appId));
                    }
                }
                catch (Exception e) { failure = e; }
            });
            thread.SetApartmentState(ApartmentState.STA);
            thread.Start();
            thread.Join();
            if (failure != null) throw failure;
            return result;
        }
    }
}
