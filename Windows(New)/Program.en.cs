// Program.cs - WinForms (.NET 8)
// Monitoring: min interval 5s; if server returns an HTTP error, a body with "error",
// or a numeric-only body, show a message box and stop monitoring.
// Tray: auto-start monitoring at launch only when config is complete;
// supports CLI flag --minimized to start directly in tray (if config is complete,
// monitoring starts first, then minimizes).
// UI: right-aligned toggle group; button bar keeps right margin; fixed-size window;
// "Allow background run" => closing the window sends it to tray; otherwise closes app.

using System;
using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Win32;
using Timer = System.Windows.Forms.Timer;

internal static class Program
{
    [STAThread]
    static void Main(string[]? args)
    {
        ApplicationConfiguration.Initialize();
        Application.Run(new MainForm(args ?? Array.Empty<string>()));
    }
}

public sealed class MainForm : Form
{
    // ===== Win32 - get active window info =====
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxLength);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    // ===== Branding (edit these as you like) =====
    private const string APP_DISPLAY_NAME = "SpyYourDesktop";
    private const string APP_BALLOON_TITLE = "SpyYourDesktop";

    // ===== CLI =====
    private readonly bool _argMinimized;

    // ===== Controls =====
    private Label lblHeader = null!, lblTopStatus = null!;
    private TextBox txtUrl = null!, txtMachineId = null!, txtKey = null!;
    private NumericUpDown numInterval = null!;
    private CheckBox chkShowKey = null!, chkAutoStart = null!, chkAllowBackground = null!;
    private Button btnStart = null!, btnStop = null!, btnOpenLog = null!;
    private Panel panelBtnBar = null!;
    private FlowLayoutPanel flpToggles = null!;
    private Label lblSecTitle = null!, lblDevId = null!, lblLastTs = null!, lblLastApp = null!;

    // ===== Tray =====
    private NotifyIcon _tray = null!;
    private ContextMenuStrip _trayMenu = null!;
    private bool _isExiting = false;
    private double _pendingRestoreOpacity = 1.0;

    // ===== Config & state =====
    private readonly string ConfigPath = Path.Combine(AppContext.BaseDirectory, "config.json");
    private readonly string LogPath = Path.Combine(AppContext.BaseDirectory, "app-usage.log");

    private AppConfig _cfg = new();
    private readonly HttpClient _http = new HttpClient();
    private readonly Timer _timer = new();

    private string? _lastTitle;
    private string? _lastApp;
    private DateTime _lastSent = DateTime.MinValue;
    private bool _busy = false;

    // Heartbeat: send once even if title unchanged after this duration
    private readonly TimeSpan HEARTBEAT = TimeSpan.FromSeconds(10);
    private const string REG_RUN = @"Software\Microsoft\Windows\CurrentVersion\Run";

    public MainForm(string[] args)
    {
        // Parse CLI: --minimized / -m
        foreach (var a in args)
        {
            if (string.Equals(a, "--minimized", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(a, "-m", StringComparison.OrdinalIgnoreCase))
            {
                _argMinimized = true;
            }
        }

        // Fixed-size window
        StartPosition = FormStartPosition.CenterScreen;
        Size = new System.Drawing.Size(820, 560);
        MinimumSize = Size;
        MaximumSize = Size;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = true;
        Font = new System.Drawing.Font("Segoe UI", 9F);
        BackColor = System.Drawing.Color.White;

        BuildUi();
        BuildTray();
        WireEvents();

        LoadConfig();
        // Back-compat: migrate old startHidden to allowBackground
        if (_cfg.StartHiddenLegacy == true) _cfg.AllowBackground = true;

        ApplyConfigToUi();
        UpdateTopStatus(false);
        WriteLogBanner();
        ApplyBranding();

        // On shown: only auto-start when config is complete; --minimized always hides to tray
        Shown += async (_, __) =>
        {
            bool canAutoStart = InputsCompleteForAutoStart();
            if (canAutoStart && !_timer.Enabled)
            {
                await StartAsync();
            }

            if (_argMinimized)
            {
                HideToTray(showBalloon: canAutoStart);
            }
        };
    }

    private void ApplyBranding()
    {
        Text = APP_DISPLAY_NAME;
        lblHeader.Text = APP_DISPLAY_NAME;

        // Use EXE icon (set in .csproj via <ApplicationIcon>)
        var icon = System.Drawing.Icon.ExtractAssociatedIcon(AppExePath()) ?? System.Drawing.SystemIcons.Application;
        this.Icon = icon;
        if (_tray != null)
        {
            _tray.Icon = icon;
            _tray.Text = APP_DISPLAY_NAME;
        }
    }

    // ===== UI =====
    private void BuildUi()
    {
        var pad = 14;

        // Top bar
        var top = new Panel { Dock = DockStyle.Top, Height = 46, BackColor = System.Drawing.Color.FromArgb(36, 95, 255) };
        lblHeader = new Label
        {
            Text = APP_DISPLAY_NAME,
            AutoSize = true,
            ForeColor = System.Drawing.Color.White,
            Left = 10,
            Top = 12,
            Font = new System.Drawing.Font("Segoe UI Semibold", 12F)
        };
        lblTopStatus = new Label
        {
            Text = "Status: Stopped",
            AutoSize = true,
            ForeColor = System.Drawing.Color.White,
            Left = 160,
            Top = 14
        };
        top.Controls.Add(lblHeader);
        top.Controls.Add(lblTopStatus);
        Controls.Add(top);

        var y = 60;

        // Server settings
        var gbServer = new GroupBox
        {
            Text = "Server Settings",
            Left = pad,
            Top = y,
            Width = ClientSize.Width - pad * 2,
            Height = 160,
            Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right
        };
        Controls.Add(gbServer);

        var lblUrl = new Label { Text = "Server URL:", Left = 10, Top = 30, AutoSize = true, Parent = gbServer };
        txtUrl = new TextBox
        {
            Left = 100,
            Top = 26,
            Width = gbServer.Width - 120,
            Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right,
            Parent = gbServer,
            Text = "http://127.0.0.1:3000/api/ingest"
        };

        var lblInterval = new Label { Text = "Interval (sec):", Left = 10, Top = 65, AutoSize = true, Parent = gbServer };
        numInterval = new NumericUpDown { Left = 100, Top = 62, Width = 80, Minimum = 5, Maximum = 3600, Value = 5, Parent = gbServer };

        var lblMachine = new Label { Text = "Machine ID:", Left = 200, Top = 65, AutoSize = true, Parent = gbServer };
        txtMachineId = new TextBox { Left = 260, Top = 62, Width = 220, PlaceholderText = "e.g., anyi-desktop", Parent = gbServer };

        var lblKey = new Label { Text = "Upload key:", Left = 10, Top = 100, AutoSize = true, Parent = gbServer };
        txtKey = new TextBox { Left = 100, Top = 97, Width = 300, Parent = gbServer, PlaceholderText = "Your personal token", UseSystemPasswordChar = false };

        // Right-aligned toggles
        flpToggles = new FlowLayoutPanel
        {
            Parent = gbServer,
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            WrapContents = false,
            FlowDirection = FlowDirection.LeftToRight,
            Top = 95,
            Anchor = AnchorStyles.Top | AnchorStyles.Right,
            Margin = new Padding(0),
            Padding = new Padding(0)
        };
        chkShowKey = new CheckBox { AutoSize = true, Text = "Show key", Checked = true, Margin = new Padding(0, 0, 18, 0) };
        chkAutoStart = new CheckBox { AutoSize = true, Text = "Run at startup", Margin = new Padding(0, 0, 18, 0) };
        chkAllowBackground = new CheckBox { AutoSize = true, Text = "Allow background run", Margin = new Padding(0) };
        flpToggles.Controls.Add(chkShowKey);
        flpToggles.Controls.Add(chkAutoStart);
        flpToggles.Controls.Add(chkAllowBackground);
        flpToggles.Left = gbServer.ClientSize.Width - flpToggles.Width - 10;
        gbServer.SizeChanged += (_, __) => flpToggles.Left = gbServer.ClientSize.Width - flpToggles.Width - 10;

        // Button bar (keeps right margin)
        const int btnW = 100, btnH = 32, gap = 10;
        panelBtnBar = new Panel
        {
            Width = btnW * 3 + gap * 2,
            Height = btnH,
            Top = gbServer.Bottom + 10,
            Left = ClientSize.Width - pad - (btnW * 3 + gap * 2),
            Anchor = AnchorStyles.Top | AnchorStyles.Right
        };
        btnStart = new Button { Text = "Start", Width = btnW, Height = btnH, Left = 0, Top = 0 };
        btnStop = new Button { Text = "Stop", Width = btnW, Height = btnH, Left = btnW + gap, Top = 0, Enabled = false };
        btnOpenLog = new Button { Text = "Open Log", Width = btnW, Height = btnH, Left = (btnW + gap) * 2, Top = 0 };
        panelBtnBar.Controls.AddRange(new Control[] { btnStart, btnStop, btnOpenLog });
        Controls.Add(panelBtnBar);

        // Status group
        var gbStatus = new GroupBox
        {
            Text = "Monitor Status",
            Left = pad,
            Top = panelBtnBar.Bottom + 10,
            Width = ClientSize.Width - pad * 2,
            Height = 140,
            Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right
        };
        Controls.Add(gbStatus);
        lblSecTitle = new Label { Text = "Machine ID:", Left = 10, Top = 30, AutoSize = true, Parent = gbStatus };
        lblDevId = new Label { Text = "-", Left = 90, Top = 30, AutoSize = true, Parent = gbStatus };

        var lblLastTsTitle = new Label { Text = "Last upload:", Left = 10, Top = 65, AutoSize = true, Parent = gbStatus };
        lblLastTs = new Label { Text = "-", Left = 90, Top = 65, AutoSize = true, Parent = gbStatus };

        var lblLastAppTitle = new Label { Text = "Last detected:", Left = 10, Top = 95, AutoSize = true, Parent = gbStatus };
        lblLastApp = new Label { Text = "-", Left = 90, Top = 95, AutoSize = true, Parent = gbStatus };
    }

    private void BuildTray()
    {
        _trayMenu = new ContextMenuStrip();
        _trayMenu.Items.Add("Open", null, (_, __) => ShowFromTray());
        _trayMenu.Items.Add("Start monitoring", null, async (_, __) => await StartAsync());
        _trayMenu.Items.Add("Stop monitoring", null, (_, __) => Stop());
        _trayMenu.Items.Add(new ToolStripSeparator());
        _trayMenu.Items.Add("Exit", null, (_, __) => { _isExiting = true; _tray.Visible = false; Close(); });

        _tray = new NotifyIcon { Visible = false, ContextMenuStrip = _trayMenu };
        _tray.DoubleClick += (_, __) => ShowFromTray();
    }

    private void WireEvents()
    {
        chkShowKey.CheckedChanged += (_, __) => txtKey.UseSystemPasswordChar = !chkShowKey.Checked;
        // Only write registry; does NOT trigger Start
        chkAutoStart.CheckedChanged += (_, __) => TrySetAutoStart(chkAutoStart.Checked);

        btnStart.Click += async (_, __) => await StartAsync();
        btnStop.Click += (_, __) => Stop();
        btnOpenLog.Click += (_, __) =>
        {
            try { Process.Start(new ProcessStartInfo("notepad.exe", $"\"{LogPath}\"") { UseShellExecute = false }); }
            catch { }
        };

        _timer.Tick += async (_, __) => await TickAsync();

        // Close: if "Allow background run" checked => to tray; otherwise exit
        FormClosing += (s, e) =>
        {
            if (!_isExiting && chkAllowBackground.Checked && e.CloseReason == CloseReason.UserClosing)
            {
                e.Cancel = true;
                HideToTray(showBalloon: false);
            }
        };
    }

    // ===== Config =====
    private void LoadConfig()
    {
        try
        {
            if (File.Exists(ConfigPath))
            {
                var json = File.ReadAllText(ConfigPath, Encoding.UTF8);
                _cfg = JsonSerializer.Deserialize<AppConfig>(json) ?? new AppConfig();
            }
        }
        catch { _cfg = new AppConfig(); }

        // Reflect registry state
        if (IsAutoStartEnabled()) _cfg.AutoStart = true;
    }

    private void SaveConfig()
    {
        _cfg.ServerUrl = txtUrl.Text.Trim();
        _cfg.IntervalSec = (int)numInterval.Value;
        _cfg.MachineId = txtMachineId.Text.Trim();
        _cfg.UploadKey = txtKey.Text;
        _cfg.AutoStart = chkAutoStart.Checked;
        _cfg.AllowBackground = chkAllowBackground.Checked;

        try
        {
            var json = JsonSerializer.Serialize(_cfg, new JsonSerializerOptions { WriteIndented = true });
            File.WriteAllText(ConfigPath, json, Encoding.UTF8);
        }
        catch { }
    }

    private void ApplyConfigToUi()
    {
        txtUrl.Text = string.IsNullOrWhiteSpace(_cfg.ServerUrl) ? "http://127.0.0.1:3000/api/ingest" : _cfg.ServerUrl;
        numInterval.Value = Math.Clamp(_cfg.IntervalSec <= 0 ? 5 : _cfg.IntervalSec, 5, 3600);
        txtMachineId.Text = _cfg.MachineId ?? "";
        txtKey.Text = _cfg.UploadKey ?? "";
        chkAutoStart.Checked = _cfg.AutoStart;
        chkAllowBackground.Checked = _cfg.AllowBackground;
        txtKey.UseSystemPasswordChar = !chkShowKey.Checked;
        lblDevId.Text = txtMachineId.Text.Trim().Length > 0 ? txtMachineId.Text.Trim() : "-";
    }

    private bool InputsCompleteForAutoStart()
    {
        var url = txtUrl.Text.Trim();
        return url.StartsWith("http", StringComparison.OrdinalIgnoreCase)
               && numInterval.Value >= 5
               && !string.IsNullOrWhiteSpace(txtMachineId.Text)
               && !string.IsNullOrWhiteSpace(txtKey.Text);
    }

    // ===== Run at startup =====
    private bool IsAutoStartEnabled()
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(REG_RUN, false);
            var val = key?.GetValue(AppName());
            return val is string s && s.Contains(AppExePath(), StringComparison.OrdinalIgnoreCase);
        }
        catch { return false; }
    }

    private void TrySetAutoStart(bool enable)
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(REG_RUN, true) ?? Registry.CurrentUser.CreateSubKey(REG_RUN, true)!;
            if (enable) key.SetValue(AppName(), $"\"{AppExePath()}\"");
            else key.DeleteValue(AppName(), false);
        }
        catch
        {
            MessageBox.Show("Failed to change startup setting. You may not have permission.", "Notice",
                MessageBoxButtons.OK, MessageBoxIcon.Warning);
            chkAutoStart.Checked = IsAutoStartEnabled(); // reflect actual state
        }
    }

    private static string AppName() => Path.GetFileNameWithoutExtension(AppExePath());
    private static string AppExePath() => Environment.ProcessPath ?? Process.GetCurrentProcess().MainModule!.FileName;

    // ===== Start / Stop =====
    private async Task StartAsync()
    {
        var url = txtUrl.Text.Trim();
        if (!url.StartsWith("http", StringComparison.OrdinalIgnoreCase))
        {
            MessageBox.Show("Server URL must start with http/https.", "Notice", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return;
        }
        if (string.IsNullOrWhiteSpace(txtMachineId.Text))
        {
            MessageBox.Show("Please enter Machine ID.", "Notice", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return;
        }

        SaveConfig();
        ToggleInputs(false);
        UpdateTopStatus(true);

        // Run once immediately
        await TickAsync();

        // Start timer (min 5s)
        _timer.Interval = Math.Max(5000, _cfg.IntervalSec * 1000);
        _timer.Start();

        btnStart.Enabled = false;
        btnStop.Enabled = true;
    }

    private void Stop()
    {
        _timer.Stop();
        UpdateTopStatus(false);
        ToggleInputs(true);
        btnStart.Enabled = true;
        btnStop.Enabled = false;
    }

    private void ToggleInputs(bool enabled)
    {
        txtUrl.ReadOnly = !enabled;
        numInterval.Enabled = enabled;
        txtMachineId.ReadOnly = !enabled;
        txtKey.ReadOnly = !enabled;
        chkShowKey.Enabled = enabled;
        chkAutoStart.Enabled = enabled;
        chkAllowBackground.Enabled = enabled;
    }

    private void UpdateTopStatus(bool running)
    {
        lblTopStatus.Text = running ? "Status: Running" : "Status: Stopped";
        lblDevId.Text = txtMachineId.Text.Trim().Length > 0 ? txtMachineId.Text.Trim() : "-";
    }

    // ===== Collect & upload =====
    private async Task TickAsync()
    {
        if (_busy) return;
        _busy = true;
        try
        {
            var (title, app, pid) = GetActiveWindowInfo();
            title = San(title);
            app = San(app);

            var changed = !string.Equals(title, _lastTitle, StringComparison.Ordinal);
            var dueHeartbeat = DateTime.UtcNow - _lastSent >= HEARTBEAT;
            if (!(changed || dueHeartbeat)) return;

            await SendAsync(new UploadEvent
            {
                machine = txtMachineId.Text.Trim(),
                window_title = title,
                app = app,
                raw = new RawInfo { exe = app, pid = pid, reason = changed ? "change" : "heartbeat" }
            });

            _lastTitle = title;
            _lastApp = app;
            _lastSent = DateTime.UtcNow;

            lblLastTs.Text = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss");
            lblLastApp.Text = $"{app} - {title}";
            AppendLog($"[sent {(changed ? "change" : "heartbeat")}] {lblLastTs.Text} | {lblLastApp.Text}");
        }
        catch (IngestErrorException ie)
        {
            AppendLog($"[error] {ie.Message}");
            Stop();
            var msg = string.IsNullOrEmpty(ie.ServerError)
                ? $"Server returned error (HTTP {ie.StatusCode}): {ie.RawBody}"
                : $"Upload rejected: {ie.ServerError}\n(HTTP {ie.StatusCode})";
            MessageBox.Show($"{msg}\n\nMonitoring has been stopped.", "Upload failed", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
        catch (Exception ex)
        {
            AppendLog($"[error] {ex.Message}");
        }
        finally { _busy = false; }
    }

    private (string title, string app, int pid) GetActiveWindowInfo()
    {
        try
        {
            var h = GetForegroundWindow();
            if (h == IntPtr.Zero) return ("", "", 0);

            var sb = new StringBuilder(1024);
            GetWindowText(h, sb, sb.Capacity);

            GetWindowThreadProcessId(h, out var pid);
            string procName = "";
            try
            {
                using var p = Process.GetProcessById((int)pid);
                procName = Path.GetFileNameWithoutExtension(p.MainModule?.FileName ?? p.ProcessName);
            }
            catch { }
            return (sb.ToString(), procName, (int)pid);
        }
        catch { return ("", "", 0); }
    }

    private async Task SendAsync(UploadEvent payload)
    {
        var url = _cfg.ServerUrl.Trim();

        using var req = new HttpRequestMessage(HttpMethod.Post, url);
        req.Content = new StringContent(JsonSerializer.Serialize(payload), Encoding.UTF8, "application/json");

        var key = (_cfg.UploadKey ?? "").Trim();
        if (!string.IsNullOrEmpty(key))
        {
            // Support both "x-name-key" and "Authorization: Bearer"
            req.Headers.TryAddWithoutValidation("x-name-key", key);
            if (!key.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase))
                req.Headers.TryAddWithoutValidation("Authorization", "Bearer " + key);
            else
                req.Headers.TryAddWithoutValidation("Authorization", key);
        }

        using var resp = await _http.SendAsync(req);
        var body = await resp.Content.ReadAsStringAsync();

        string? serverErr = TryExtractServerError(body);
        bool isNumericOnly = IsAllDigits(body?.Trim());

        if (!resp.IsSuccessStatusCode || serverErr != null || isNumericOnly)
        {
            int code = (int)resp.StatusCode;
            if (code == 0 && isNumericOnly && int.TryParse(body.Trim(), out var n)) code = n;
            throw new IngestErrorException($"ingest failed: {code} {body}", code,
                serverErr ?? (isNumericOnly ? $"code {body.Trim()}" : null), body);
        }
    }

    // ===== Tray helpers =====
    private void HideToTray(bool showBalloon)
    {
        // Avoid flash: set transparent before hide
        double oldOpacity = Opacity;
        try { Opacity = 0; } catch { }
        _tray.Visible = true;
        ShowInTaskbar = false;
        Hide();
        _pendingRestoreOpacity = oldOpacity;

        if (showBalloon)
        {
            _tray.BalloonTipTitle = APP_BALLOON_TITLE;
            _tray.BalloonTipText = _timer.Enabled ? "Running in background. Double-click the tray icon to restore." : "Minimized to tray.";
            _tray.ShowBalloonTip(2000);
        }
    }

    private void ShowFromTray()
    {
        _tray.Visible = false;
        ShowInTaskbar = true;
        Show();
        WindowState = FormWindowState.Normal;
        try { Opacity = _pendingRestoreOpacity; } catch { }
        Activate();
    }

    // ===== Helpers =====
    private static string? TryExtractServerError(string? body)
    {
        if (string.IsNullOrWhiteSpace(body)) return null;
        var t = body.Trim();
        try
        {
            using var doc = JsonDocument.Parse(t);
            if (doc.RootElement.ValueKind == JsonValueKind.Object &&
                doc.RootElement.TryGetProperty("error", out var e) &&
                e.ValueKind == JsonValueKind.String)
            {
                var s = e.GetString();
                if (!string.IsNullOrWhiteSpace(s)) return s;
            }
        }
        catch { }
        if (t.IndexOf("error", StringComparison.OrdinalIgnoreCase) >= 0) return t;
        return null;
    }

    private static bool IsAllDigits(string? s)
    {
        if (string.IsNullOrEmpty(s)) return false;
        foreach (var c in s) if (!char.IsDigit(c)) return false;
        return true;
    }

    private static string San(string? s)
    {
        if (string.IsNullOrWhiteSpace(s)) return "";
        var t = s.Replace("\r", " ").Replace("\n", " ").Trim();
        return t.Length > 512 ? t[..512] : t;
    }

    private void AppendLog(string line)
    {
        try { File.AppendAllText(LogPath, $"{DateTime.Now:yyyy-MM-dd HH:mm:ss} {line}{Environment.NewLine}", Encoding.UTF8); } catch { }
    }
    private void WriteLogBanner() => AppendLog("=== AppUsageMonitor started ===");

    // ===== DTO / Config =====
    private sealed class AppConfig
    {
        [JsonPropertyName("serverUrl")] public string ServerUrl { get; set; } = "http://127.0.0.1:3000/api/ingest";
        [JsonPropertyName("intervalSec")] public int IntervalSec { get; set; } = 5;
        [JsonPropertyName("machineId")] public string? MachineId { get; set; }
        [JsonPropertyName("uploadKey")] public string? UploadKey { get; set; }
        [JsonPropertyName("autoStart")] public bool AutoStart { get; set; } = false;
        [JsonPropertyName("allowBackground")] public bool AllowBackground { get; set; } = false;
        // Back-compat field from older versions
        [JsonPropertyName("startHidden")] public bool? StartHiddenLegacy { get; set; }
    }

    private sealed class UploadEvent
    {
        public string machine { get; set; } = "";
        public string? window_title { get; set; }
        public string? app { get; set; }
        public RawInfo? raw { get; set; }
    }
    private sealed class RawInfo
    {
        public string? exe { get; set; }
        public int pid { get; set; }
        public string? reason { get; set; }
    }

    private sealed class IngestErrorException : Exception
    {
        public int StatusCode { get; }
        public string? ServerError { get; }
        public string RawBody { get; }
        public IngestErrorException(string message, int statusCode, string? serverError, string rawBody) : base(message)
        { StatusCode = statusCode; ServerError = serverError; RawBody = rawBody; }
    }
}
