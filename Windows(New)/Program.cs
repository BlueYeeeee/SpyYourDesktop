// Program.cs - WinForms (.NET 8)
// - 监控：最小间隔5s；服务端错误/纯数字响应 → 弹窗并停止
// - 托盘：配置齐全才自动开始；支持 --minimized 启动即进托盘；允许后台运行=关闭进托盘
// - UI：按钮区与右侧留白；复选框单独一行避免冲突；所有 Label 透明底；窗口不可拉伸
// - 日志：全部写入 AppBase\logs\；每次启动新建 app-usage_yyyy-MM-dd_HH-mm-ss.log
// - 新增：强制心跳(秒)（≥10s），与“监控间隔”并排；“设备ID”右移且自适应

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
    // ===== Win32 =====
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxLength);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    // ===== 品牌（可改） =====
    private const string APP_DISPLAY_NAME = "SpyYourDesktop";
    private const string APP_BALLOON_TITLE = "SpyYourDesktop";

    // ===== CLI =====
    private readonly bool _argMinimized;

    // ===== 控件 =====
    private Label lblHeader = null!, lblTopStatus = null!;
    private TextBox txtUrl = null!, txtMachineId = null!, txtKey = null!;
    private NumericUpDown numInterval = null!, numHeartbeat = null!;
    private CheckBox chkShowKey = null!, chkAutoStart = null!, chkAllowBackground = null!;
    private Button btnStart = null!, btnStop = null!, btnOpenLog = null!;
    private Panel panelBtnBar = null!;
    private FlowLayoutPanel flpToggles = null!;
    private Label lblSecTitle = null!, lblDevId = null!, lblLastTs = null!, lblLastApp = null!;

    // ===== 托盘 =====
    private NotifyIcon _tray = null!;
    private ContextMenuStrip _trayMenu = null!;
    private bool _isExiting = false;
    private double _pendingRestoreOpacity = 1.0;

    // ===== 配置与状态 =====
    private readonly string ConfigPath = Path.Combine(AppContext.BaseDirectory, "config.json");

    // 日志目录 & 本次运行日志文件
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

    private const int MIN_HEARTBEAT_SEC = 10; // 强制心跳下限
    private const string REG_RUN = @"Software\Microsoft\Windows\CurrentVersion\Run";

    public MainForm(string[] args)
    {
        foreach (var a in args)
            if (string.Equals(a, "--minimized", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(a, "-m", StringComparison.OrdinalIgnoreCase))
                _argMinimized = true;

        _logFileName = $"app-usage_{DateTime.Now:yyyy-MM-dd_HH-mm-ss}.log";
        try { Directory.CreateDirectory(LogDir); } catch { }

        // 固定窗口
        StartPosition = FormStartPosition.CenterScreen;
        Size = new System.Drawing.Size(880, 560);
        MinimumSize = Size;
        MaximumSize = Size;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = true;
        Font = new System.Drawing.Font("Microsoft YaHei UI", 9F);
        BackColor = System.Drawing.Color.White;

        BuildUi();
        BuildTray();
        WireEvents();

        LoadConfig();
        if (_cfg.StartHiddenLegacy == true) _cfg.AllowBackground = true; // 兼容旧字段

        ApplyConfigToUi();
        UpdateTopStatus(false);
        WriteLogBanner();
        ApplyBranding();

        Shown += async (_, __) =>
        {
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

    // 顶栏
    var top = new Panel { Dock = DockStyle.Top, Height = 46, BackColor = System.Drawing.Color.FromArgb(36, 95, 255) };
    lblHeader = new Label { Text = APP_DISPLAY_NAME, AutoSize = true, ForeColor = System.Drawing.Color.White, Left = 10, Top = 12,
                            Font = new System.Drawing.Font("Microsoft YaHei UI", 12F, System.Drawing.FontStyle.Bold) };
    lblTopStatus = new Label { Text = "状态：未运行", AutoSize = true, ForeColor = System.Drawing.Color.White, Left = 160, Top = 14 };
    top.Controls.Add(lblHeader); top.Controls.Add(lblTopStatus);
    Controls.Add(top);

    // 服务器设置（栅格布局，防重叠 + 统一基线）
    var y = 60;
    var gbServer = new GroupBox
    {
        Text = "服务器设置",
        Left = pad, Top = y,
        Width = ClientSize.Width - pad * 2, Height = 200,
        Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right
    };
    Controls.Add(gbServer);

    var tlp = new TableLayoutPanel
    {
        Dock = DockStyle.Fill,
        ColumnCount = 6,
        RowCount = 4,
        Padding = new Padding(10, 8, 10, 8)
    };
    // 列：L | 数值 | L | 数值 | L | 伸展输入
    tlp.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));             // 0 Label
    tlp.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 70));         // 1 short control (~2位数)
    tlp.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));             // 2 Label
    tlp.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 70));         // 3 short control
    tlp.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));             // 4 Label
    tlp.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));         // 5 long fill

    // 行高固定，控件在行内垂直居中，避免不在同一水平线
    tlp.RowStyles.Add(new RowStyle(SizeType.Absolute, 32));
    tlp.RowStyles.Add(new RowStyle(SizeType.Absolute, 32));
    tlp.RowStyles.Add(new RowStyle(SizeType.Absolute, 32));
    tlp.RowStyles.Add(new RowStyle(SizeType.Absolute, 30));

    // 统一的边距
    var labelMargin = new Padding(0, 6, 8, 0);
    var inputMargin = new Padding(0, 2, 10, 2);

    // 行1：服务器地址
    var lblUrl = new Label { Text = "服务器地址：", AutoSize = true, Margin = labelMargin };
    txtUrl = new TextBox { Text = "http://127.0.0.1:3000/api/ingest", Anchor = AnchorStyles.Left | AnchorStyles.Right, Margin = inputMargin };
    tlp.Controls.Add(lblUrl, 0, 0);
    tlp.Controls.Add(txtUrl, 1, 0);
    tlp.SetColumnSpan(txtUrl, 5);

    // 行2：监控间隔 + 强制心跳 + 设备ID
    var lblInterval = new Label { Text = "监控间隔(秒)：", AutoSize = true, Margin = labelMargin };
    numInterval = new NumericUpDown
    {
        Minimum = 5, Maximum = 3600, Value = 5, Width = 56,
        Anchor = AnchorStyles.Left, Margin = inputMargin
    };
    var lblHeartbeat = new Label { Text = "强制心跳(秒)：", AutoSize = true, Margin = labelMargin };
    numHeartbeat = new NumericUpDown
    {
        Minimum = MIN_HEARTBEAT_SEC, Maximum = 3600, Value = 10, Width = 56,
        Anchor = AnchorStyles.Left, Margin = inputMargin
    };
    var lblMachine = new Label { Text = "设备 ID：", AutoSize = true, Margin = labelMargin };
    txtMachineId = new TextBox
    {
        Anchor = AnchorStyles.Left | AnchorStyles.Right,
        PlaceholderText = "如：anyi-desktop",
        Margin = inputMargin
    };

    tlp.Controls.Add(lblInterval, 0, 1);
    tlp.Controls.Add(numInterval, 1, 1);
    tlp.Controls.Add(lblHeartbeat, 2, 1);
    tlp.Controls.Add(numHeartbeat, 3, 1);
    tlp.Controls.Add(lblMachine, 4, 1);
    tlp.Controls.Add(txtMachineId, 5, 1);

    // 行3：上传密钥
    var lblKey = new Label { Text = "上传密钥：", AutoSize = true, Margin = labelMargin };
    txtKey = new TextBox
    {
        Anchor = AnchorStyles.Left | AnchorStyles.Right,
        PlaceholderText = "你的个人密钥 / 令牌",
        UseSystemPasswordChar = false,
        Margin = inputMargin
    };
    tlp.Controls.Add(lblKey, 0, 2);
    tlp.Controls.Add(txtKey, 1, 2);
    tlp.SetColumnSpan(txtKey, 5);

    // 行4：复选框（整行）
    flpToggles = new FlowLayoutPanel
    {
        AutoSize = true,
        AutoSizeMode = AutoSizeMode.GrowAndShrink,
        WrapContents = false,
        FlowDirection = FlowDirection.LeftToRight,
        Margin = new Padding(0, 2, 0, 0)
    };
    chkShowKey = new CheckBox { AutoSize = true, Text = "显示密钥", Checked = true, Margin = new Padding(0, 0, 18, 0) };
    chkAutoStart = new CheckBox { AutoSize = true, Text = "开机自启动", Margin = new Padding(0, 0, 18, 0) };
    chkAllowBackground = new CheckBox { AutoSize = true, Text = "允许后台运行" };
    flpToggles.Controls.Add(chkShowKey);
    flpToggles.Controls.Add(chkAutoStart);
    flpToggles.Controls.Add(chkAllowBackground);

    // 放在第1列起，跨5列
    tlp.Controls.Add(new Label() { Width = 0, AutoSize = true }, 0, 3); // 占位
    tlp.Controls.Add(flpToggles, 1, 3);
    tlp.SetColumnSpan(flpToggles, 5);

    gbServer.Controls.Add(tlp);

    // 按钮条（右侧留白）
    const int btnW = 100, btnH = 32, gap = 10;
    panelBtnBar = new Panel
    {
        Width = btnW * 3 + gap * 2, Height = btnH,
        Top = gbServer.Bottom + 10,
        Left = ClientSize.Width - pad - (btnW * 3 + gap * 2),
        Anchor = AnchorStyles.Top | AnchorStyles.Right
    };
    btnStart = new Button { Text = "开始监控", Width = btnW, Height = btnH, Left = 0, Top = 0 };
    btnStop = new Button { Text = "停止监控", Width = btnW, Height = btnH, Left = btnW + gap, Top = 0, Enabled = false };
    btnOpenLog = new Button { Text = "打开日志", Width = btnW, Height = btnH, Left = (btnW + gap) * 2, Top = 0 };
    panelBtnBar.Controls.AddRange(new Control[] { btnStart, btnStop, btnOpenLog });
    Controls.Add(panelBtnBar);

    // 状态框
    var gbStatus = new GroupBox
    {
        Text = "监控状态",
        Left = pad, Top = panelBtnBar.Bottom + 10,
        Width = ClientSize.Width - pad * 2, Height = 140,
        Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right
    };
    Controls.Add(gbStatus);
    lblSecTitle = new Label { Text = "设备ID：", Left = 10, Top = 30, AutoSize = true, Parent = gbStatus };
    lblDevId = new Label { Text = "-", Left = 70, Top = 30, AutoSize = true, Parent = gbStatus };
    var lblLastTsTitle = new Label { Text = "最后上报时间：", Left = 10, Top = 65, AutoSize = true, Parent = gbStatus };
    lblLastTs = new Label { Text = "-", Left = 110, Top = 65, AutoSize = true, Parent = gbStatus };
    var lblLastAppTitle = new Label { Text = "最后检测应用：", Left = 10, Top = 95, AutoSize = true, Parent = gbStatus };
    lblLastApp = new Label { Text = "-", Left = 110, Top = 95, AutoSize = true, Parent = gbStatus };

    // Label 全部透明，避免遮挡
    MakeLabelsTransparent(this);
}

    private void BuildTray()
    {
        _trayMenu = new ContextMenuStrip();
        _trayMenu.Items.Add("打开主界面", null, (_, __) => ShowFromTray());
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
        chkAutoStart.CheckedChanged += (_, __) => TrySetAutoStart(chkAutoStart.Checked); // 仅写注册表

        btnStart.Click += async (_, __) => await StartAsync();
        btnStop.Click += (_, __) => Stop();
        btnOpenLog.Click += (_, __) =>
        {
            try { Process.Start(new ProcessStartInfo("notepad.exe", $"\"{LogPath}\"") { UseShellExecute = false }); } catch { }
        };

        _timer.Tick += async (_, __) => await TickAsync();

        // 关闭：允许后台运行 → 托盘；否则退出
        FormClosing += (s, e) =>
        {
            if (!_isExiting && chkAllowBackground.Checked && e.CloseReason == CloseReason.UserClosing)
            {
                e.Cancel = true;
                HideToTray(showBalloon: false);
            }
        };
    }

    // ===== 工具：让所有 Label 透明底 =====
    private void MakeLabelsTransparent(Control root)
    {
        foreach (Control c in root.Controls)
        {
            if (c is Label lbl) lbl.BackColor = System.Drawing.Color.Transparent;
            if (c.HasChildren) MakeLabelsTransparent(c);
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

        await TickAsync(); // 立即跑一次

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
        try
        {
            var (title, app, pid) = GetActiveWindowInfo();
            title = San(title); app = San(app);

            var changed = !string.Equals(title, _lastTitle, StringComparison.Ordinal);
            var dueHeartbeat = DateTime.UtcNow - _lastSent >= CurrentHeartbeat();
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
            Stop();
            var msg = string.IsNullOrEmpty(ie.ServerError)
                ? $"服务器返回错误（HTTP {ie.StatusCode}）：{ie.RawBody}"
                : $"服务器拒绝上报：{ie.ServerError}\n（HTTP {ie.StatusCode}）";
            MessageBox.Show($"{msg}\n\n监控已停止。", "上报失败", MessageBoxButtons.OK, MessageBoxIcon.Warning);
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

    // ===== 托盘 =====
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

    // ===== 工具 =====
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
        } catch { }
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
        // 兼容旧字段
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
