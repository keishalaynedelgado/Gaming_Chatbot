// The whole Windows app: one window with a WebView2 (Microsoft Edge's
// engine) playing the game embedded in this .exe. Everything it needs -- the
// game files, the WebView2 SDK assemblies and its native loader -- is carried
// inside as resources and unpacked to %LOCALAPPDATA%\AskViGames on first run,
// so the export is a single file. Written in C# 5, the version understood by
// the compiler that ships with Windows (.NET Framework's csc.exe).
// GameInfo (AppId, Title, Version) is generated per export next to this file.
using System;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

static class Program
{
    const string GamePrefix = "game/";

    [STAThread]
    static void Main()
    {
        AppDomain.CurrentDomain.AssemblyResolve += ResolveEmbedded;
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Run();
    }

    // Separate from Main so the WebView2 types are only loaded after the
    // resolver above is registered.
    static void Run()
    {
        Application.Run(new GameForm());
    }

    static Assembly ResolveEmbedded(object sender, ResolveEventArgs e)
    {
        byte[] bytes = ReadResource("lib/" + new AssemblyName(e.Name).Name + ".dll");
        return bytes == null ? null : Assembly.Load(bytes);
    }

    static byte[] ReadResource(string name)
    {
        using (Stream s = Assembly.GetExecutingAssembly().GetManifestResourceStream(name))
        {
            if (s == null) return null;
            using (MemoryStream m = new MemoryStream())
            {
                s.CopyTo(m);
                return m.ToArray();
            }
        }
    }

    public static string DataDir()
    {
        return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "AskViGames", GameInfo.AppId);
    }

    // Unpacks this version's game files (once) and returns their folder.
    public static string ExtractGame()
    {
        string dir = Path.Combine(DataDir(), "v" + GameInfo.Version);
        string marker = Path.Combine(dir, ".complete");
        if (File.Exists(marker)) return Path.Combine(dir, "game");
        Assembly self = Assembly.GetExecutingAssembly();
        foreach (string name in self.GetManifestResourceNames())
        {
            if (!name.StartsWith(GamePrefix, StringComparison.Ordinal)) continue;
            string target = Path.Combine(dir, name.Replace('/', Path.DirectorySeparatorChar));
            Directory.CreateDirectory(Path.GetDirectoryName(target));
            File.WriteAllBytes(target, ReadResource(name));
        }
        File.WriteAllText(marker, DateTime.UtcNow.ToString("o"));
        return Path.Combine(dir, "game");
    }

    [DllImport("kernel32", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr LoadLibrary(string path);

    // WebView2's native loader must be loaded before the first WebView2 call;
    // once loaded by full path, the SDK finds it by name.
    public static void LoadWebView2Loader()
    {
        string arch = Environment.Is64BitProcess ? "x64" : "x86";
        string dir = Path.Combine(DataDir(), "native", arch);
        string dll = Path.Combine(dir, "WebView2Loader.dll");
        if (!File.Exists(dll))
        {
            Directory.CreateDirectory(dir);
            File.WriteAllBytes(dll, ReadResource("native/" + arch + "/WebView2Loader.dll"));
        }
        LoadLibrary(dll);
    }
}

class GameForm : Form
{
    const string Host = "askvi-game.example";
    readonly WebView2 web;

    public GameForm()
    {
        Text = GameInfo.Title;
        ClientSize = new Size(1280, 800);
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Color.Black;
        try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }
        web = new WebView2();
        web.Dock = DockStyle.Fill;
        web.DefaultBackgroundColor = Color.Black;
        Controls.Add(web);
        Load += async (s, e) => await Start();
    }

    async Task Start()
    {
        try
        {
            string gameDir = Program.ExtractGame();
            Program.LoadWebView2Loader();
            CoreWebView2Environment env = await CoreWebView2Environment.CreateAsync(null, Path.Combine(Program.DataDir(), "WebView2Data"), null);
            await web.EnsureCoreWebView2Async(env);
            CoreWebView2 core = web.CoreWebView2;
            core.Settings.AreDevToolsEnabled = false;
            core.Settings.AreDefaultContextMenusEnabled = false;
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.IsZoomControlEnabled = false;
            core.SetVirtualHostNameToFolderMapping(Host, gameDir, CoreWebView2HostResourceAccessKind.Deny);
            core.NewWindowRequested += (s, e) => { e.Handled = true; };
            core.NavigationStarting += (s, e) =>
            {
                if (!new Uri(e.Uri).Host.Equals(Host, StringComparison.OrdinalIgnoreCase)) e.Cancel = true;
            };
            core.DocumentTitleChanged += (s, e) =>
            {
                if (!string.IsNullOrWhiteSpace(core.DocumentTitle)) Text = core.DocumentTitle;
            };
            web.Source = new Uri("https://" + Host + "/index.html");
        }
        catch (WebView2RuntimeNotFoundException)
        {
            MessageBox.Show(
                "This game needs the Microsoft Edge WebView2 Runtime, which is not installed on this PC.\n\n" +
                "Download it from https://go.microsoft.com/fwlink/p/?LinkId=2124703 and run the game again.",
                GameInfo.Title, MessageBoxButtons.OK, MessageBoxIcon.Information);
            Close();
        }
        catch (Exception ex)
        {
            MessageBox.Show("The game could not start: " + ex.Message, GameInfo.Title, MessageBoxButtons.OK, MessageBoxIcon.Error);
            Close();
        }
    }
}
