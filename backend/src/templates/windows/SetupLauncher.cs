// The Windows "Setup" download for an exported game (see exporter.js): a
// small .exe carrying the game's icon, with the game's MSI (installer.wxs)
// inside. Double-clicked:
//   - not installed, or an older version installed: installs (or updates)
//     it with Windows Installer's small progress window; the MSI then opens
//     the game itself when it finishes
//   - this version (or newer) already installed: just opens the game
// Uninstalling is only ever done from Settings > Apps. Written in C# 5, the
// version understood by the compiler that ships with Windows.
// SetupInfo (AppId, Title, Version, FolderName, ExeName) is generated per
// export next to this file.
using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Windows.Forms;
using Microsoft.Win32;

static class Setup
{
    [STAThread]
    static int Main()
    {
        string game = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", SetupInfo.FolderName, SetupInfo.ExeName);
        try
        {
            if (IsInstalled() && File.Exists(game))
            {
                ProcessStartInfo run = new ProcessStartInfo(game);
                run.WorkingDirectory = Path.GetDirectoryName(game);
                run.UseShellExecute = true;
                Process.Start(run);
                return 0;
            }
            return Install();
        }
        catch (Exception ex)
        {
            MessageBox.Show(SetupInfo.Title + " could not be started: " + ex.Message, SetupInfo.Title, MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }

    // This version, or a newer one, is installed for this user.
    static bool IsInstalled()
    {
        using (RegistryKey key = Registry.CurrentUser.OpenSubKey(@"Software\AskViGames\" + SetupInfo.AppId))
        {
            if (key == null) return false;
            object value = key.GetValue("Version");
            Version installed;
            return value != null && Version.TryParse(value.ToString(), out installed) && installed >= new Version(SetupInfo.Version);
        }
    }

    static int Install()
    {
        string msi = Path.Combine(Path.GetTempPath(), "AskViGames-" + SetupInfo.AppId + "-" + SetupInfo.Version + ".msi");
        using (Stream source = Assembly.GetExecutingAssembly().GetManifestResourceStream("game.msi"))
        using (FileStream target = File.Create(msi))
        {
            source.CopyTo(target);
        }
        try
        {
            // /qb: only a small progress window, no dialogs to click through.
            ProcessStartInfo msiexec = new ProcessStartInfo("msiexec.exe", "/i \"" + msi + "\" /qb");
            msiexec.UseShellExecute = false;
            Process p = Process.Start(msiexec);
            p.WaitForExit();
            // 0 = done, 1602 = cancelled by the user, 3010 = done (restart suggested).
            if (p.ExitCode != 0 && p.ExitCode != 1602 && p.ExitCode != 3010)
            {
                MessageBox.Show(SetupInfo.Title + " could not be installed (Windows Installer error " + p.ExitCode + ").", SetupInfo.Title, MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
            return p.ExitCode == 3010 ? 0 : p.ExitCode;
        }
        finally
        {
            try { File.Delete(msi); } catch { }
        }
    }
}
