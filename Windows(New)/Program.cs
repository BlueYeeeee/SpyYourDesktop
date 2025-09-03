// Program.cs - WinForms (.NET 8)
// 合并更新：隐私模式（运行中可切换，不落盘）、GitHub 发布说明、原有限频/心跳/托盘/更新/日志逻辑保留

using System;
using System.ComponentModel; // Win32Exception
using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Win32;
using Timer = System.Windows.Forms.Timer;

internal static class Program
{
    [STAThread]
    static void Main(string[]? args)
    {
        bool createdNew;
        using var mutex = new System.Threading.Mutex(true, "SpyYourDesktop_Singleton", out createdNew);
        if (!createdNew)
        {
            MessageBox.Show("应用已在运行。", "提示", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }

        ApplicationConfiguration.Initialize();
        Application.Run(new MainForm(args ?? Array.Empty<string>()));
    }
}

public sealed class MainForm : Form
{
    // ===== Win32 =====
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxLength);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    // ===== 品牌 =====
    private const string APP_DISPLAY_NAME = "SpyYourDesktop";
    private const string APP_BALLOON_TITLE = "SpyYourDesktop";

    // ===== GitHub 仓库（检查更新使用） =====
    private const string GITHUB_OWNER = "BlueYeeeee";
    private const string GITHUB_REPO  = "SpyYourDesktop";

    // ===== CLI =====
    private readonly bool _argMinimized;
    private readonly bool _isElevatedUpdateMode = false;
    private readonly string? _elevatedUpdateUrl;
    private readonly string? _elevatedUpdateTag;

    // ===== 控件 =====
    private Label lblHeader = null!, lblTopStatus = null!;
    private TextBox txtUrl = null!, txtMachineId = null!, txtKey = null!;
    private NumericUpDown numInterval = null!, numHeartbeat = null!;
    private CheckBox chkShowKey = null!, chkAutoStart = null!, chkAllowBackground = null!, chkPrivacy = null!;
    private Button btnStart = null!, btnStop = null!, btnOpenLog = null!;
    private Panel panelBtnBar = null!;
    private FlowLayoutPanel flpToggles = null!;
    private Label lblSecTitle = null!, lblDevId = null!, lblLastTs = null!, lblLastApp = null!;

    // ===== 托盘 =====
    private NotifyIcon _tray = null!;
    private ContextMenuStrip _trayMenu = null!;
    private ToolStripMenuItem? _trayPrivacyItem;
    private bool _isExiting = false;
    private double _pendingRestoreOpacity = 1.0;

    // ===== 配置 / 日志 =====
    private readonly string ConfigPath = Path.Combine(AppContext.BaseDirectory, "config.json");
    private readonly string LogDir = Path.Combine(AppContext.BaseDirectory, "logs");
    private readonly string _logFileName;
    private string LogPath => Path.Combine(LogDir, _logFileName);

    private AppConfig _cfg = new();
    private readonly HttpClient _http = new HttpClient();
    private readonly Timer _timer = new();

    private string? _lastTitle;
    private string? _lastApp;
    private DateTime _lastSent = DateTime.MinValue;
    private bool _busy = false;

    // 隐私模式：默认 false，不落盘；运行中可改
    private bool _privacyMode = false;
    private bool _syncingPrivacy = false;

    private const int MIN_HEARTBEAT_SEC = 10;
    private const string REG_RUN = @"Software\Microsoft\Windows\CurrentVersion\Run";

    public MainForm(string[] args)
    {
        for (int i = 0; i < args.Length; i++)
        {
            var a = args[i];
            if (string.Equals(a, "--minimized", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(a, "-m", StringComparison.OrdinalIgnoreCase))
                _argMinimized = true;

            if (string.Equals(a, "--elevated-update", StringComparison.OrdinalIgnoreCase))
            {
                _isElevatedUpdateMode = true;
                _elevatedUpdateUrl = i + 1 < args.Length ? args[i + 1] : null;
                _elevatedUpdateTag = i + 2 < args.Length ? args[i + 2] : null;
            }
        }

        _logFileName = $"app-usage_{DateTime.Now:yyyy-MM-dd_HH-mm-ss}.log";
        try { Directory.CreateDirectory(LogDir); } catch { }

        // 固定窗口
        StartPosition = FormStartPosition.CenterScreen;
        Size = new System.Drawing.Size(880, 560);
        MinimumSize = Size; MaximumSize = Size;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false; MinimizeBox = true;
        Font = new System.Drawing.Font("Microsoft YaHei UI", 9F);
        BackColor = System.Drawing.Color.White;

        BuildUi(); BuildTray(); WireEvents();

        LoadConfig();
        if (_cfg.StartHiddenLegacy == true) _cfg.AllowBackground = true;

        // 每次启动都默认关闭隐私模式（不写配置）
        _privacyMode = false;
        chkPrivacy.Checked = false;

        ApplyConfigToUi();
        UpdateTopStatus(false);
        WriteLogBanner();
        ApplyBranding();

        Shown += async (_, __) =>
        {
            if (_isElevatedUpdateMode && !string.IsNullOrWhiteSpace(_elevatedUpdateUrl))
            {
                await ElevatedDownloadAndApplyAsync(_elevatedUpdateUrl!, _elevatedUpdateTag ?? "latest");
                return;
            }

            // 启动时静默检查更新（失败不打扰）
            await CheckUpdatesAsync(manual:false);

            bool canAutoStart = InputsCompleteForAutoStart();
            if (canAutoStart && !_timer.Enabled) await StartAsync();
            if (_argMinimized) HideToTray(showBalloon: canAutoStart);
        };
    }

    private void ApplyBranding()
    {
        Text = APP_DISPLAY_NAME;
        lblHeader.Text = APP_DISPLAY_NAME;
        var icon = System.Drawing.Icon.ExtractAssociatedIcon(AppExePath()) ?? System.Drawing.SystemIcons.Application;
        this.Icon = icon;
        if (_tray != null) { _tray.Icon = icon; _tray.Text = APP_DISPLAY_NAME; }
    }

    // ===== UI =====
    private void BuildUi()
    {
        var pad = 14;
        var top = new Panel { Dock = DockStyle.Top, Height = 46, BackColor = System.Drawing.Color.FromArgb(36, 95, 255) };
        lblHeader = new Label { Text = APP_DISPLAY_NAME, AutoSize = true, ForeColor = System.Drawing.Color.White, Left = 10, Top = 12,
                                Font = new System.Drawing.Font("Microsoft YaHei UI", 12F, System.Drawing.FontStyle.Bold) };
        lblTopStatus = new Label { Text = "状态：未运行", AutoSize = true, ForeColor = System.Drawing.Color.White, Left = 160, Top = 14 };
        top.Controls.Add(lblHeader); top.Controls.Add(lblTopStatus);
        Controls.Add(top);

        var y = 60;
        var gbServer = new GroupBox { Text = "服务器设置", Left = pad, Top = y, Width = ClientSize.Width - pad * 2, Height = 200, Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right };
        Controls.Add(gbServer);

        var tlp = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 6, RowCount = 4, Padding = new Padding(10, 8, 10, 8) };
        tlp.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        tlp.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 70));
        tlp.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        tlp.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 70));
        tlp.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        tlp.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        tlp.RowStyles.Add(new RowStyle(SizeType.Absolute, 32));
        tlp.RowStyles.Add(new RowStyle(SizeType.Absolute, 32));
        tlp.RowStyles.Add(new RowStyle(SizeType.Absolute, 32));
        tlp.RowStyles.Add(new RowStyle(SizeType.Absolute, 30));
        var labelMargin = new Padding(0, 6, 8, 0);
        var inputMargin = new Padding(0, 2, 10, 2);

        var lblUrl = new Label { Text = "服务器地址：", AutoSize = true, Margin = labelMargin };
        txtUrl = new TextBox { Text = "http://127.0.0.1:3000/api/ingest", Anchor = AnchorStyles.Left | AnchorStyles.Right, Margin = inputMargin };
        tlp.Controls.Add(lblUrl, 0, 0); tlp.Controls.Add(txtUrl, 1, 0); tlp.SetColumnSpan(txtUrl, 5);

        var lblInterval = new Label { Text = "监控间隔(秒)：", AutoSize = true, Margin = labelMargin };
        numInterval = new NumericUpDown { Minimum = 5, Maximum = 3600, Value = 5, Width = 56, Anchor = AnchorStyles.Left, Margin = inputMargin };
        var lblHeartbeat = new Label { Text = "强制心跳(秒)：", AutoSize = true, Margin = labelMargin };
        numHeartbeat = new NumericUpDown { Minimum = MIN_HEARTBEAT_SEC, Maximum = 3600, Value = 10, Width = 56, Anchor = AnchorStyles.Left, Margin = inputMargin };
        var lblMachine = new Label { Text = "设备 ID：", AutoSize = true, Margin = labelMargin };
        txtMachineId = new TextBox { Anchor = AnchorStyles.Left | AnchorStyles.Right, PlaceholderText = "如：anyi-desktop", Margin = inputMargin };

        tlp.Controls.Add(lblInterval, 0, 1); tlp.Controls.Add(numInterval, 1, 1);
        tlp.Controls.Add(lblHeartbeat, 2, 1); tlp.Controls.Add(numHeartbeat, 3, 1);
        tlp.Controls.Add(lblMachine, 4, 1); tlp.Controls.Add(txtMachineId, 5, 1);

        var lblKey = new Label { Text = "上传密钥：", AutoSize = true, Margin = labelMargin };
        txtKey = new TextBox { Anchor = AnchorStyles.Left | AnchorStyles.Right, PlaceholderText = "你的个人密钥 / 令牌", UseSystemPasswordChar = false, Margin = inputMargin };
        tlp.Controls.Add(lblKey, 0, 2); tlp.Controls.Add(txtKey, 1, 2); tlp.SetColumnSpan(txtKey, 5);

        flpToggles = new FlowLayoutPanel { AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, WrapContents = false, FlowDirection = FlowDirection.LeftToRight, Margin = new Padding(0, 2, 0, 0) };
        chkShowKey = new CheckBox { AutoSize = true, Text = "显示密钥", Checked = true, Margin = new Padding(0, 0, 18, 0) };
        chkAutoStart = new CheckBox { AutoSize = true, Text = "开机自启动", Margin = new Padding(0, 0, 18, 0) };
        chkAllowBackground = new CheckBox { AutoSize = true, Text = "允许后台运行", Margin = new Padding(0, 0, 18, 0) };
        chkPrivacy = new CheckBox { AutoSize = true, Text = "隐私模式（不采集标题/应用）" };

        flpToggles.Controls.Add(chkShowKey);
        flpToggles.Controls.Add(chkAutoStart);
        flpToggles.Controls.Add(chkAllowBackground);
        flpToggles.Controls.Add(chkPrivacy);

        tlp.Controls.Add(new Label() { Width = 0, AutoSize = true }, 0, 3);
        tlp.Controls.Add(flpToggles, 1, 3); tlp.SetColumnSpan(flpToggles, 5);
        Controls.Add(gbServer);
        gbServer.Controls.Add(tlp);

        const int btnW = 100, btnH = 32, gap = 10;
        panelBtnBar = new Panel { Width = btnW * 3 + gap * 2, Height = btnH, Top = gbServer.Bottom + 10, Left = ClientSize.Width - pad - (btnW * 3 + gap * 2), Anchor = AnchorStyles.Top | AnchorStyles.Right };
        btnStart = new Button { Text = "开始监控", Width = btnW, Height = btnH, Left = 0, Top = 0 };
        btnStop = new Button { Text = "停止监控", Width = btnW, Height = btnH, Left = btnW + gap, Top = 0, Enabled = false };
        btnOpenLog = new Button { Text = "打开日志", Width = btnW, Height = btnH, Left = (btnW + gap) * 2, Top = 0 };
        panelBtnBar.Controls.AddRange(new Control[] { btnStart, btnStop, btnOpenLog });
        Controls.Add(panelBtnBar);

        var gbStatus = new GroupBox { Text = "监控状态", Left = pad, Top = panelBtnBar.Bottom + 10, Width = ClientSize.Width - pad * 2, Height = 140, Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right };
        Controls.Add(gbStatus);
        lblSecTitle = new Label { Text = "设备ID：", Left = 10, Top = 30, AutoSize = true, Parent = gbStatus };
        lblDevId = new Label { Text = "-", Left = 70, Top = 30, AutoSize = true, Parent = gbStatus };
        var lblLastTsTitle = new Label { Text = "最后上报时间：", Left = 10, Top = 65, AutoSize = true, Parent = gbStatus };
        lblLastTs = new Label { Text = "-", Left = 110, Top = 65, AutoSize = true, Parent = gbStatus };
        var lblLastAppTitle = new Label { Text = "最后检测应用：", Left = 10, Top = 95, AutoSize = true, Parent = gbStatus };
        lblLastApp = new Label { Text = "-", Left = 110, Top = 95, AutoSize = true, Parent = gbStatus };

        MakeLabelsTransparent(this);
    }

    private void BuildTray()
    {
        _trayMenu = new ContextMenuStrip();
        _trayMenu.Items.Add("打开主界面", null, (_, __) => ShowFromTray());
        _trayMenu.Items.Add("检查更新", null, async (_, __) => await CheckUpdatesAsync(manual: true));
        _trayPrivacyItem = new ToolStripMenuItem("隐私模式（不采集标题/应用）") { Checked = _privacyMode };
        _trayPrivacyItem.Click += (_, __) => { chkPrivacy.Checked = !_privacyMode; };
        _trayMenu.Items.Add(_trayPrivacyItem);
        _trayMenu.Items.Add("开始监控", null, async (_, __) => await StartAsync());
        _trayMenu.Items.Add("停止监控", null, (_, __) => Stop());
        _trayMenu.Items.Add(new ToolStripSeparator());
        _trayMenu.Items.Add("退出", null, (_, __) => { _isExiting = true; _tray.Visible = false; Close(); });

        _tray = new NotifyIcon { Visible = false, ContextMenuStrip = _trayMenu };
        _tray.DoubleClick += (_, __) => ShowFromTray();
    }

    private void WireEvents()
    {
        chkShowKey.CheckedChanged += (_, __) => txtKey.UseSystemPasswordChar = !chkShowKey.Checked;
        chkAutoStart.CheckedChanged += (_, __) => TrySetAutoStart(chkAutoStart.Checked);

        // 隐私模式切换：运行中也能改；立即上报一次
        chkPrivacy.CheckedChanged += async (_, __) =>
        {
            if (_syncingPrivacy) return;
            _syncingPrivacy = true;
            _privacyMode = chkPrivacy.Checked;
            if (_trayPrivacyItem != null) _trayPrivacyItem.Checked = _privacyMode;
            AppendLog(_privacyMode ? "[privacy] ON" : "[privacy] OFF");
            _syncingPrivacy = false;
            if (_timer.Enabled) await TickAsync(); // 即刻按新状态上报一次
        };

        btnStart.Click += async (_, __) => await StartAsync();
        btnStop.Click += (_, __) => Stop();
        btnOpenLog.Click += (_, __) =>
        {
            try { Process.Start(new ProcessStartInfo("notepad.exe", $"\"{LogPath}\"") { UseShellExecute = false }); } catch { }
        };

        _timer.Tick += async (_, __) => await TickAsync();

        FormClosing += (s, e) =>
        {
            if (!_isExiting && chkAllowBackground.Checked && e.CloseReason == CloseReason.UserClosing)
            {
                e.Cancel = true;
                HideToTray(showBalloon: false);
            }
        };
    }

    private void MakeLabelsTransparent(Control root)
    {
        foreach (Control ctl in root.Controls)
        {
            if (ctl is Label lbl) lbl.BackColor = System.Drawing.Color.Transparent;
            if (ctl.HasChildren) MakeLabelsTransparent(ctl);
        }
    }

    // ===== 配置 =====
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

        if (IsAutoStartEnabled()) _cfg.AutoStart = true;
    }

    private void SaveConfig()
    {
        _cfg.ServerUrl = txtUrl.Text.Trim();
        _cfg.IntervalSec = (int)numInterval.Value;
        _cfg.HeartbeatSec = Math.Max(MIN_HEARTBEAT_SEC, (int)numHeartbeat.Value);
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
        numHeartbeat.Value = Math.Clamp(_cfg.HeartbeatSec <= 0 ? MIN_HEARTBEAT_SEC : _cfg.HeartbeatSec, MIN_HEARTBEAT_SEC, 3600);
        txtMachineId.Text = _cfg.MachineId ?? "";
        txtKey.Text = _cfg.UploadKey ?? "";
        chkAutoStart.Checked = _cfg.AutoStart;
        chkAllowBackground.Checked = _cfg.AllowBackground;
        txtKey.UseSystemPasswordChar = !chkShowKey.Checked;
        lblDevId.Text = txtMachineId.Text.Trim().Length > 0 ? txtMachineId.Text.Trim() : "-";
        // 隐私模式不写配置，UI 默认已是 false
        chkPrivacy.Enabled = true;
    }

    private bool InputsCompleteForAutoStart()
    {
        var url = txtUrl.Text.Trim();
        return url.StartsWith("http", StringComparison.OrdinalIgnoreCase)
               && numInterval.Value >= 5
               && numHeartbeat.Value >= MIN_HEARTBEAT_SEC
               && !string.IsNullOrWhiteSpace(txtMachineId.Text)
               && !string.IsNullOrWhiteSpace(txtKey.Text);
    }

    // ===== 开机自启 =====
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
            MessageBox.Show("设置开机自启动失败，可能没有权限。", "提示", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            chkAutoStart.Checked = IsAutoStartEnabled();
        }
    }

    private static string AppName() => Path.GetFileNameWithoutExtension(AppExePath());
    private static string AppExePath() => Environment.ProcessPath ?? Process.GetCurrentProcess().MainModule!.FileName;

    // ===== 开始/停止 =====
    private async Task StartAsync()
    {
        var url = txtUrl.Text.Trim();
        if (!url.StartsWith("http", StringComparison.OrdinalIgnoreCase))
        { MessageBox.Show("服务器地址必须以 http/https 开头。", "提示", MessageBoxButtons.OK, MessageBoxIcon.Warning); return; }
        if (string.IsNullOrWhiteSpace(txtMachineId.Text))
        { MessageBox.Show("请填写 设备 ID。", "提示", MessageBoxButtons.OK, MessageBoxIcon.Warning); return; }

        SaveConfig();
        ToggleInputs(false);
        UpdateTopStatus(true);

        await TickAsync(); // 立即采样一次

        _timer.Interval = Math.Max(5000, _cfg.IntervalSec * 1000);
        _timer.Start();

        btnStart.Enabled = false; btnStop.Enabled = true;
    }

    private void Stop()
    {
        _timer.Stop();
        UpdateTopStatus(false);
        ToggleInputs(true);
        btnStart.Enabled = true; btnStop.Enabled = false;
    }

    private void ToggleInputs(bool enabled)
    {
        txtUrl.ReadOnly = !enabled;
        numInterval.Enabled = enabled;
        numHeartbeat.Enabled = enabled;
        txtMachineId.ReadOnly = !enabled;
        txtKey.ReadOnly = !enabled;
        chkShowKey.Enabled = enabled;
        chkAutoStart.Enabled = enabled;
        chkAllowBackground.Enabled = enabled;

        // 隐私模式在运行时也允许随时切换
        chkPrivacy.Enabled = true;
        if (_trayPrivacyItem != null) _trayPrivacyItem.Enabled = true;
    }

    private void UpdateTopStatus(bool running)
    {
        lblTopStatus.Text = running ? "状态：运行中" : "状态：未运行";
        lblDevId.Text = txtMachineId.Text.Trim().Length > 0 ? txtMachineId.Text.Trim() : "-";
    }

    // ===== 采集与上报 =====
    private TimeSpan CurrentHeartbeat() =>
        TimeSpan.FromSeconds(Math.Max(MIN_HEARTBEAT_SEC, _cfg.HeartbeatSec > 0 ? _cfg.HeartbeatSec : (int)numHeartbeat.Value));

    private async Task TickAsync()
    {
        if (_busy) return;
        _busy = true;

        string? attemptedTitle = null;
        string? attemptedApp = null;

        try
        {
            string title, app; int pid;
            if (_privacyMode)
            {
                title = "TA现在不想给你看QAQ";
                app = "private mode";
                pid = 0;
            }
            else
            {
                var info = GetActiveWindowInfo();
                title = San(info.title);
                app = San(info.app);
                pid = info.pid;
            }

            attemptedTitle = title;
            attemptedApp = app;

            bool changed = !string.Equals(title, _lastTitle, StringComparison.Ordinal);
            bool dueHeartbeat = DateTime.UtcNow - _lastSent >= CurrentHeartbeat();

            if (!(changed || dueHeartbeat)) return;

            await SendAsync(new UploadEvent
            {
                machine = txtMachineId.Text.Trim(),
                window_title = title,
                app = app,
                raw = new RawInfo { exe = app, pid = pid, reason = changed ? "change" : "heartbeat" }
            });

            _lastTitle = title; _lastApp = app; _lastSent = DateTime.UtcNow;

            lblLastTs.Text = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss");
            lblLastApp.Text = $"{app} - {title}";
            AppendLog($"[sent {(changed ? "change" : "heartbeat")}] {lblLastTs.Text} | {lblLastApp.Text}");
        }
        catch (IngestErrorException ie)
        {
            AppendLog($"[error] {ie.Message}");

            if (ie.StatusCode == 429)
            {
                int backoff = ParseRetryAfterMs(ie.RawBody, 800);
                backoff = Math.Clamp(backoff + 250, 300, 5000);
                AppendLog($"[rate-limit] backoff {backoff}ms");
                await Task.Delay(backoff);
                return;
            }

            if (IsWindowTitleTooLongError(ie))
            {
                var (limitNum, titleLen) = ExtractLimitLength(ie.ServerError ?? ie.RawBody ?? string.Empty);
                if (limitNum.HasValue || titleLen.HasValue)
                    AppendLog($"[title-too-long] submitted app='{attemptedApp ?? "-"}' | title='{attemptedTitle ?? "-"}' (limit={limitNum?.ToString() ?? "?"}, length={titleLen?.ToString() ?? "?"})");
                else
                    AppendLog($"[title-too-long] submitted app='{attemptedApp ?? "-"}' | title='{attemptedTitle ?? "-"}'");
            }

            Stop();
            string dialogTitle = "ERROR:" + (ie.ServerError ?? "上报失败");
            string dialogContent = ie.RawBody ?? "无返回信息，请查看日志";
            MessageBox.Show($"{dialogContent}\n\n监控已停止。", dialogTitle, MessageBoxButtons.OK, MessageBoxIcon.Warning);
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

        // Windows 端上报时带版本与 OS
        payload.app_version = GetCurrentVersionString();
        payload.os = "Windows";

        using var req = new HttpRequestMessage(HttpMethod.Post, url);
        req.Content = new StringContent(JsonSerializer.Serialize(payload), Encoding.UTF8, "application/json");

        // Header 同时附带版本与 OS
        req.Headers.TryAddWithoutValidation("X-App-Version", payload.app_version);
        req.Headers.TryAddWithoutValidation("X-OS", "Windows");

        var key = (_cfg.UploadKey ?? "").Trim();
        if (!string.IsNullOrEmpty(key))
        {
            req.Headers.TryAddWithoutValidation("x-name-key", key);
            if (!key.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase))
                req.Headers.TryAddWithoutValidation("Authorization", "Bearer " + key);
            else
                req.Headers.TryAddWithoutValidation("Authorization", key);
        }

        using var resp = await _http.SendAsync(req);
        var body = await resp.Content.ReadAsStringAsync();
        var (errTitle, errMessage) = TryExtractServerError(body);
        bool isNumericOnly = IsAllDigits(body?.Trim());

        if (!resp.IsSuccessStatusCode || errTitle != null || isNumericOnly)
        {
            int code = (int)resp.StatusCode;
            if (code == 0 && isNumericOnly && int.TryParse(body.Trim(), out var numericCode))
                code = numericCode;

            string errorMsg;
            if (errTitle != null && errMessage != null)
                errorMsg = $"ingest failed: {code} {errTitle} - {errMessage}";
            else if (errTitle != null)
                errorMsg = $"ingest failed: {code} {errTitle}";
            else
                errorMsg = $"ingest failed: {code} {body}";

            throw new IngestErrorException(
                errorMsg,
                code,
                errTitle ?? (isNumericOnly ? $"code {body.Trim()}" : null),
                errMessage ?? body
            );
        }
    }

    // ===== GitHub 更新：版本工具/下载/应用 =====
    private static string GetCurrentVersionString()
    {
        var info = typeof(MainForm).Assembly
            .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion;
        return string.IsNullOrWhiteSpace(info) ? Application.ProductVersion : info!;
    }

    private static Version ParseVersionLoose(string? v)
    {
        if (string.IsNullOrWhiteSpace(v)) return new Version(0, 0, 0, 0);
        var s = v.Trim();
        if (s.StartsWith("v", StringComparison.OrdinalIgnoreCase)) s = s[1..];
        var dash = s.IndexOfAny(new[] { '-', '+' });
        if (dash >= 0) s = s[..dash];
        return Version.TryParse(s, out var ver) ? ver : new Version(0, 0, 0, 0);
    }

    // 返回：tag、html_url、exe下载链接、发布说明（纯文本）
    private async Task<(string tag, string htmlUrl, string? exeUrl, string notes)> FetchLatestReleaseWithExeAsync()
    {
        var apiUrl = $"https://api.github.com/repos/{GITHUB_OWNER}/{GITHUB_REPO}/releases/latest";

        using var req = new HttpRequestMessage(HttpMethod.Get, apiUrl);
        req.Headers.TryAddWithoutValidation("User-Agent", $"{APP_DISPLAY_NAME}/1.0");
        req.Headers.TryAddWithoutValidation("Accept", "application/vnd.github+json");

        using var resp = await _http.SendAsync(req);
        var body = await resp.Content.ReadAsStringAsync();

        if (!resp.IsSuccessStatusCode)
            throw new Exception($"github api {resp.StatusCode}: {body}");

        using var doc = JsonDocument.Parse(body);
        var root = doc.RootElement;

        var tag = root.TryGetProperty("tag_name", out var tn) && tn.ValueKind == JsonValueKind.String ? tn.GetString() ?? "" : "";
        var url = root.TryGetProperty("html_url", out var hu) && hu.ValueKind == JsonValueKind.String ? hu.GetString() ?? "" : "";
        var notes = root.TryGetProperty("body", out var bdy) && bdy.ValueKind == JsonValueKind.String ? (bdy.GetString() ?? "").Trim() : "";

        // 取第一个 .exe 资源
        string? exeUrl = null;
        if (root.TryGetProperty("assets", out var assets) && assets.ValueKind == JsonValueKind.Array)
        {
            foreach (var a in assets.EnumerateArray())
            {
                if (a.TryGetProperty("browser_download_url", out var d) && d.ValueKind == JsonValueKind.String)
                {
                    var link = d.GetString() ?? "";
                    if (link.EndsWith(".exe", StringComparison.OrdinalIgnoreCase))
                    {
                        exeUrl = link;
                        break;
                    }
                }
            }
        }

        return (tag, url, exeUrl, notes);
    }

    private sealed class DownloadProgressForm : Form
    {
        public ProgressBar Bar { get; } = new ProgressBar { Dock = DockStyle.Top, Height = 24, Minimum = 0, Maximum = 100 };
        public Label Lbl { get; } = new Label { Dock = DockStyle.Top, AutoSize = false, Height = 22, TextAlign = System.Drawing.ContentAlignment.MiddleLeft };
        public DownloadProgressForm(string title, bool centerOnScreen)
        {
            Text = title;
            StartPosition = centerOnScreen ? FormStartPosition.CenterScreen : FormStartPosition.CenterParent;
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = MinimizeBox = false;
            Width = 420; Height = 120;
            Controls.Add(Bar);
            Controls.Add(Lbl);
            Padding = new Padding(12);
        }
    }

    private async Task DownloadToPathWithProgressAsync(string url, string destPath, IWin32Window owner)
    {
        try { Directory.CreateDirectory(Path.GetDirectoryName(destPath)!); } catch { }

        using var req = new HttpRequestMessage(HttpMethod.Get, url);
        req.Headers.TryAddWithoutValidation("User-Agent", $"{APP_DISPLAY_NAME}/1.0");

        using var resp = await _http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead);
        resp.EnsureSuccessStatusCode();

        long? total = null;
        if (resp.Content.Headers.TryGetValues("Content-Length", out var vals))
        {
            var first = System.Linq.Enumerable.FirstOrDefault(vals);
            if (long.TryParse(first, out var cl)) total = cl;
        }

        using var s = await resp.Content.ReadAsStreamAsync();
        using var fs = new FileStream(destPath, FileMode.Create, FileAccess.Write, FileShare.None);

        var dlg = new DownloadProgressForm("正在下载更新…", centerOnScreen: !this.Visible);
        dlg.Lbl.Text = "准备下载…";
        dlg.Bar.Value = 0;
        dlg.Show(owner);

        var buffer = new byte[81920];
        long readTotal = 0;
        int read;
        try
        {
            while ((read = await s.ReadAsync(buffer, 0, buffer.Length)) > 0)
            {
                await fs.WriteAsync(buffer, 0, read);
                readTotal += read;

                if (total.HasValue && total.Value > 0)
                {
                    var pct = (int)Math.Clamp(readTotal * 100 / total.Value, 0, 100);
                    dlg.Bar.Value = pct;
                    dlg.Lbl.Text = $"已下载 {readTotal / 1024} KB / {total.Value / 1024} KB";
                    dlg.Refresh();
                }
                else
                {
                    dlg.Lbl.Text = $"已下载 {readTotal / 1024} KB";
                    dlg.Refresh();
                }
            }
            dlg.Bar.Value = 100;
            dlg.Lbl.Text = "下载完成";
        }
        finally
        {
            await Task.Delay(300);
            dlg.Close();
            dlg.Dispose();
        }
    }

    private void ElevateAndUpdate(string downloadUrl, string tag)
    {
        try
        {
            var psi = new ProcessStartInfo
            {
                FileName = AppExePath(),
                Arguments = $"--elevated-update \"{downloadUrl}\" \"{tag}\"",
                UseShellExecute = true,
                Verb = "runas",
                WindowStyle = ProcessWindowStyle.Normal
            };
            Process.Start(psi);
            _isExiting = true; _tray.Visible = false; Close();
        }
        catch (Win32Exception w32) when (w32.NativeErrorCode == 1223)
        {
            MessageBox.Show("已取消管理员授权，无法写入安装目录。", "更新", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
        catch (Exception ex)
        {
            MessageBox.Show($"请求管理员权限失败：{ex.Message}", "更新", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    private async Task ElevatedDownloadAndApplyAsync(string url, string tag)
    {
        try
        {
            var exePath = AppExePath();
            var exeDir = Path.GetDirectoryName(exePath)!;
            var exeName = Path.GetFileName(exePath);
            var newPath = Path.Combine(exeDir, exeName + ".new");

            await DownloadToPathWithProgressAsync(url, newPath, this);
            CreateAndRunUpdateBat(exePath, newPath, exeName);
        }
        catch (Exception ex)
        {
            AppendLog($"[elevated-update] {ex.Message}");
            MessageBox.Show($"更新失败（提权实例）：{ex.Message}", "更新", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    private void CreateAndRunUpdateBat(string exePath, string newPath, string exeName)
    {
        var exeDir = Path.GetDirectoryName(exePath)!;
        var batPath = Path.Combine(exeDir, "update_run.bat");

        File.WriteAllText(batPath, $@"
@echo off
setlocal enableextensions
set ""EXE={exePath}""
set ""NEW={newPath}""
set ""EXENAME={exeName}""
set ""EXEDIR={exeDir}""

:waitproc
tasklist /FI ""IMAGENAME eq %EXENAME%"" | find /I ""%EXENAME%"" >nul
if %errorlevel%==0 (
  timeout /t 1 /nobreak >nul 2>&1 || ping 127.0.0.1 -n 2 >nul
  goto waitproc
)

set /a i=0
:deltry
del /f /q ""%EXE%"" >nul 2>&1
if exist ""%EXE%"" (
  set /a i+=1
  if %i% lss 20 (
    timeout /t 1 /nobreak >nul 2>&1 || ping 127.0.0.1 -n 2 >nul
    goto deltry
  )
)

if exist ""%NEW%"" (
  move /y ""%NEW%"" ""%EXE%"" >nul 2>&1
  if exist ""%NEW%"" (
    rename ""%NEW%"" ""%EXENAME%"" >nul 2>&1
  )
)

start """" ""%EXE%""
del ""%~f0""
");

        var psi = new ProcessStartInfo
        {
            FileName = batPath,
            WorkingDirectory = exeDir,
            UseShellExecute = true,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden,
            Verb = "open"
        };
        Process.Start(psi);

        try { Environment.Exit(0); } catch { Process.GetCurrentProcess().Kill(); }
    }

    private async Task CheckUpdatesAsync(bool manual)
    {
        try
        {
            var (tag, releaseUrl, exeUrl, notes) = await FetchLatestReleaseWithExeAsync();
            if (string.IsNullOrWhiteSpace(tag))
            {
                if (manual) MessageBox.Show("未获取到最新版本信息。", "检查更新", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }

            if (!string.IsNullOrWhiteSpace(_cfg.SkippedVersion) &&
                string.Equals(_cfg.SkippedVersion, tag, StringComparison.OrdinalIgnoreCase) &&
                !manual)
            {
                return;
            }

            var currentStr = GetCurrentVersionString();
            var current = ParseVersionLoose(currentStr);
            var latest = ParseVersionLoose(tag);

            if (latest > current)
            {
                string notesShort = string.IsNullOrWhiteSpace(notes) ? "(无发布说明)" : notes;
                if (notesShort.Length > 1200) notesShort = notesShort[..1200] + "...";
                var msg = $"发现新版本：{tag}\n当前版本：{currentStr}\n\n更新内容：\n{notesShort}\n\n现在下载并自动更新吗？\n\n“否”：稍后提醒\n“取消”：本版本不再提醒";
                var result = MessageBox.Show(msg, "发现更新", MessageBoxButtons.YesNoCancel, MessageBoxIcon.Information);

                if (result == DialogResult.Yes)
                {
                    var targetUrl = exeUrl ?? releaseUrl;
                    if (string.IsNullOrWhiteSpace(targetUrl))
                    {
                        MessageBox.Show("未找到下载链接。", "更新", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                        return;
                    }

                    var exePath = AppExePath();
                    var exeDir = Path.GetDirectoryName(exePath)!;
                    var exeName = Path.GetFileName(exePath);
                    var newPath = Path.Combine(exeDir, exeName + ".new");

                    try
                    {
                        await DownloadToPathWithProgressAsync(targetUrl, newPath, this);
                    }
                    catch (UnauthorizedAccessException)
                    {
                        ElevateAndUpdate(targetUrl, tag);
                        return;
                    }
                    catch (IOException ioex) when (ioex.Message.IndexOf("denied", StringComparison.OrdinalIgnoreCase) >= 0)
                    {
                        ElevateAndUpdate(targetUrl, tag);
                        return;
                    }
                    catch (Exception ex)
                    {
                        AppendLog($"[update-download] {ex.Message}");
                        MessageBox.Show($"下载失败：{ex.Message}", "更新", MessageBoxButtons.OK, MessageBoxIcon.Error);
                        return;
                    }

                    try
                    {
                        CreateAndRunUpdateBat(exePath, newPath, exeName);
                    }
                    catch (Exception ex)
                    {
                        AppendLog($"[update-apply] {ex.Message}");
                        MessageBox.Show($"应用更新失败：{ex.Message}", "更新", MessageBoxButtons.OK, MessageBoxIcon.Error);
                    }
                }
                else if (result == DialogResult.Cancel)
                {
                    _cfg.SkippedVersion = tag;
                    SaveConfig();
                }
            }
            else
            {
                if (manual)
                    MessageBox.Show($"已是最新版本（当前：{currentStr}，最新：{tag}）。", "检查更新", MessageBoxButtons.OK, MessageBoxIcon.Information);
            }
        }
        catch (Exception ex)
        {
            AppendLog($"[update-check] {ex.Message}");
            if (manual)
                MessageBox.Show($"检查更新失败：{ex.Message}", "检查更新", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
    }

    // ===== 托盘/工具/日志/DTO =====
    private void HideToTray(bool showBalloon)
    {
        double oldOpacity = Opacity;
        try { Opacity = 0; } catch { }
        _tray.Visible = true;
        ShowInTaskbar = false;
        Hide();
        _pendingRestoreOpacity = oldOpacity;

        if (showBalloon)
        {
            _tray.BalloonTipTitle = APP_BALLOON_TITLE;
            _tray.BalloonTipText = _timer.Enabled ? "正在后台运行，双击图标可恢复窗口。" : "已最小化到托盘。";
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

    private static int ParseRetryAfterMs(string text, int fallbackMs = 800)
    {
        try
        {
            using var doc = JsonDocument.Parse(text.Trim());
            var root = doc.RootElement;

            if (root.TryGetProperty("retry_after_ms", out var ra) && ra.TryGetInt32(out var ms) && ms > 0)
                return ms;

            int? minMs = null, elapsed = null;
            if (root.TryGetProperty("min_interval_ms", out var mi) && mi.TryGetInt32(out var miVal)) minMs = miVal;
            if (root.TryGetProperty("elapsed_ms", out var el) && el.TryGetInt32(out var elVal)) elapsed = elVal;
            if (minMs.HasValue && elapsed.HasValue)
                return Math.Max(0, minMs.Value - elapsed.Value);
        }
        catch { }

        return fallbackMs;
    }

    private static (string? Error, string? Message) TryExtractServerError(string? body)
    {
        if (string.IsNullOrWhiteSpace(body)) return (null, null);

        var t = body.Trim();
        var jsonStart = t.IndexOf('{');
        if (jsonStart >= 0)
        {
            var jsonPart = t.Substring(jsonStart);
            try
            {
                using var jsonDoc = JsonDocument.Parse(jsonPart);
                var root = jsonDoc.RootElement;
                if (root.ValueKind == JsonValueKind.Object)
                {
                    string? err = null, msg = null;
                    if (root.TryGetProperty("error", out JsonElement errorElem) && errorElem.ValueKind == JsonValueKind.String)
                        err = errorElem.GetString();
                    if (root.TryGetProperty("message", out JsonElement msgElem) && msgElem.ValueKind == JsonValueKind.String)
                        msg = msgElem.GetString();
                    if (!string.IsNullOrWhiteSpace(err) || !string.IsNullOrWhiteSpace(msg))
                        return (err, msg);
                }
            }
            catch (JsonException) { }
            catch (Exception) { }
        }
        if (t.IndexOf("error", StringComparison.OrdinalIgnoreCase) >= 0)
            return ("Error", t);
        return (null, null);
    }

    private static string NormalizeToJson(string s)
    {
        s = s.Trim();
        if (s.StartsWith("(") && s.EndsWith(")")) s = "{" + s.Substring(1, s.Length - 2) + "}";
        return s;
    }

    private static bool IsWindowTitleTooLongError(IngestErrorException ie)
    {
        var text = (ie.ServerError ?? ie.RawBody ?? string.Empty);
        return text.IndexOf("window title too long", StringComparison.OrdinalIgnoreCase) >= 0
            || text.IndexOf("window_title too long", StringComparison.OrdinalIgnoreCase) >= 0;
    }

    private static (int? limit, int? length) ExtractLimitLength(string text)
    {
        int? limitVal = null, lengthVal = null;
        try
        {
            using var jsonDoc = JsonDocument.Parse(NormalizeToJson(text));
            var root = jsonDoc.RootElement;
            if (root.ValueKind == JsonValueKind.Object)
            {
                if (root.TryGetProperty("limit", out JsonElement limitElem) && limitElem.TryGetInt32(out var parsedLimit))
                    limitVal = parsedLimit;
                if (root.TryGetProperty("length", out JsonElement lengthElem) && lengthElem.TryGetInt32(out var parsedLength))
                    lengthVal = parsedLength;
                if (limitVal.HasValue || lengthVal.HasValue) return (limitVal, lengthVal);
            }
        }
        catch { }
        var mLimit = Regex.Match(text, @"\blimit\s*[:=]\s*(\d+)", RegexOptions.IgnoreCase);
        if (mLimit.Success && int.TryParse(mLimit.Groups[1].Value, out var rxLimit)) limitVal = rxLimit;
        var mLength = Regex.Match(text, @"\blength\s*[:=]\s*(\d+)", RegexOptions.IgnoreCase);
        if (mLength.Success && int.TryParse(mLength.Groups[1].Value, out var rxLength)) lengthVal = rxLength;
        return (limitVal, lengthVal);
    }

    private static bool IsAllDigits(string? s)
    {
        if (string.IsNullOrEmpty(s)) return false;
        foreach (var ch in s) if (!char.IsDigit(ch)) return false;
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

    // ===== DTO =====
    private sealed class AppConfig
    {
        [JsonPropertyName("serverUrl")] public string ServerUrl { get; set; } = "http://127.0.0.1:3000/api/ingest";
        [JsonPropertyName("intervalSec")] public int IntervalSec { get; set; } = 5;
        [JsonPropertyName("heartbeatSec")] public int HeartbeatSec { get; set; } = 10;
        [JsonPropertyName("machineId")] public string? MachineId { get; set; }
        [JsonPropertyName("uploadKey")] public string? UploadKey { get; set; }
        [JsonPropertyName("autoStart")] public bool AutoStart { get; set; } = false;
        [JsonPropertyName("allowBackground")] public bool AllowBackground { get; set; } = false;
        [JsonPropertyName("startHidden")] public bool? StartHiddenLegacy { get; set; }
        [JsonPropertyName("skipVersion")] public string? SkippedVersion { get; set; }
    }

    private sealed class UploadEvent
    {
        public string machine { get; set; } = "";
        public string? window_title { get; set; }
        public string? app { get; set; }
        public RawInfo? raw { get; set; }
        public string? app_version { get; set; }
        public string? os { get; set; }
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
