using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Threading;

internal static class Launcher
{
    private static readonly Assembly Self = Assembly.GetExecutingAssembly();

    public static int Main(string[] args)
    {
        AppContext.SetSwitch("Switch.System.IO.UseLegacyPathHandling", false);
        AppContext.SetSwitch("Switch.System.IO.BlockLongPaths", false);
        Console.OutputEncoding = new UTF8Encoding(false);
        try
        {
            string[] identity;
            using (var input = new StreamReader(Self.GetManifestResourceStream("BundleIdentity")))
                identity = input.ReadToEnd().Split(new[] { "\r\n", "\n" }, StringSplitOptions.RemoveEmptyEntries);
            string local = Environment.GetEnvironmentVariable("LOCALAPPDATA");
            if (String.IsNullOrWhiteSpace(local) || !Path.IsPathRooted(local))
                throw new IOException("The current user's LocalAppData directory is unavailable.");
            string root = Path.Combine(local, "VoxFigura", "Portable");
            string app = Prepare(root, identity[0], identity[1], identity[2]);
            if (Array.IndexOf(args, "--extract-only") >= 0)
            {
                Console.WriteLine("BUNDLE=" + app);
                return 0;
            }
            return Launch(app, Array.IndexOf(args, "--no-browser") >= 0);
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("VoxFigura: " + error.Message);
            if (Array.IndexOf(args, "--no-browser") < 0 && Array.IndexOf(args, "--extract-only") < 0 &&
                !Console.IsInputRedirected)
            {
                Console.WriteLine("Press Enter to close.");
                Console.ReadLine();
            }
            return 1;
        }
    }

    private static string Prepare(string root, string name, string hash, string manifestHash)
    {
        Directory.CreateDirectory(root);
        string app = Path.Combine(root, name + "-" + hash.Substring(0, 16));
        using (Lock(app + ".lock"))
        {
            if (IsReady(app, manifestHash))
                return app;
            Console.WriteLine("Preparing VoxFigura for this Windows account...");
            string scratch = Path.Combine(root, ".u-" + Guid.NewGuid().ToString("N").Substring(0, 12));
            Directory.CreateDirectory(scratch);
            try
            {
                string exactly = Path.Combine(scratch, "payload.7z");
                string extractor = Path.Combine(scratch, "7zr.exe");
                string extracted = Path.Combine(scratch, "app");
                Directory.CreateDirectory(extracted);
                StoreResource("BundleArchive", exactly);
                if (Digest(exactly) != hash)
                    throw new IOException("The embedded archive checksum did not match.");
                StoreResource("BundleExtractor", extractor);
                var unpack = new ProcessStartInfo(extractor,
                    "x -y -bd -bso0 -bsp0 -sccUTF-8 " + Quote(exactly) + " " + Quote("-o" + extracted));
                unpack.WorkingDirectory = scratch;
                unpack.UseShellExecute = false;
                using (var child = Process.Start(unpack))
                {
                    child.WaitForExit();
                    if (child.ExitCode != 0)
                        throw new IOException("The embedded archive did not extract successfully.");
                }
                if (!IsReady(extracted, manifestHash))
                    throw new IOException("Required runtime files were missing after extraction.");
                if (Directory.Exists(app))
                    Directory.Move(app, app + ".incomplete-" + Guid.NewGuid().ToString("N"));
                Directory.Move(extracted, app);
                return app;
            }
            finally
            {
                Directory.Delete(scratch, true);
            }
        }
    }

    private static FileStream Lock(string file)
    {
        var timeout = Stopwatch.StartNew();
        for (;;)
        {
            try { return new FileStream(file, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None); }
            catch (IOException)
            {
                if (timeout.Elapsed >= TimeSpan.FromMinutes(3))
                    throw;
                Thread.Sleep(300);
            }
        }
    }

    private static bool IsReady(string app, string manifestHash)
    {
        string manifest = Path.Combine(app, "bundle-manifest.json");
        return File.Exists(manifest) && Digest(manifest) == manifestHash
            && File.Exists(Path.Combine(app, "runtime", "node", "node.exe"))
            && File.Exists(Path.Combine(app, "runtime", "python", "python.exe"))
            && File.Exists(Path.Combine(app, "server", "portable.mjs"));
    }

    private static void StoreResource(string name, string output)
    {
        using (var source = Self.GetManifestResourceStream(name))
        using (var target = new FileStream(output, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            source.CopyTo(target, 1024 * 1024);
    }

    private static string Digest(string path)
    {
        using (var hash = SHA256.Create())
        using (var input = File.OpenRead(path))
            return BitConverter.ToString(hash.ComputeHash(input)).Replace("-", "").ToLowerInvariant();
    }

    private static int Launch(string app, bool noBrowser)
    {
        var start = new ProcessStartInfo(Path.Combine(app, "runtime", "node", "node.exe"),
            Quote(Path.Combine(app, "server", "portable.mjs")) + " --parent-stdin" + (noBrowser ? " --no-browser" : ""));
        start.WorkingDirectory = app;
        start.UseShellExecute = false;
        start.RedirectStandardInput = true;
        foreach (string key in new[] { "NODE_OPTIONS", "NODE_PATH", "NODE_EXTRA_CA_CERTS", "NODE_V8_COVERAGE" })
            start.EnvironmentVariables.Remove(key);
        using (var child = Process.Start(start))
        {
            ConsoleCancelEventHandler stop = (sender, args) =>
            {
                args.Cancel = true;
                child.StandardInput.Close();
            };
            Console.CancelKeyPress += stop;
            try
            {
                child.WaitForExit();
                return child.ExitCode;
            }
            finally
            {
                Console.CancelKeyPress -= stop;
            }
        }
    }

    private static string Quote(string value)
    {
        return "\"" + value + "\"";
    }
}
