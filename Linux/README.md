# SpyYourDesktop Linux 客户端

这是 SpyYourDesktop 的独立 Linux 上报端，复用原有服务端的 `POST /api/ingest` 接口，**不修改服务端任何代码或配置结构**。

它只采集并上传：

- 当前活动窗口的标题（`window_title`）
- 当前活动窗口所属应用名（`app`）
- 设备 ID、来源方式、PID（放在 `raw` 中）

不会上传截图、键盘输入、剪贴板、文件内容或窗口内文字。

> **声明：Linux客户端只在Ubuntu 26.04的kde-wayland桌面环境测试通过**；其他桌面环境、发行版和架构均未实测。
>
> Wayland 出于安全设计，默认不允许普通程序读取全局活动窗口。不同桌面需要走各自的接口，详见下方“桌面环境支持”。

---

## 1. 下载与安装

到本项目的 Releases 页面下载：

- `spy-your-desktop`：无后缀单文件二进制（amd64，推荐）
- `spy-your-desktop_1.0.0_amd64.deb`：Debian/Ubuntu 安装包

### 方式 A：deb 安装包

```bash
sudo apt install ./spy-your-desktop_1.0.0_amd64.deb
```

或者：

```bash
sudo dpkg -i spy-your-desktop_1.0.0_amd64.deb
sudo apt -f install
```

安装后命令位于 `/usr/bin/spy-your-desktop`。

### 方式 B：单文件二进制

```bash
chmod +x spy-your-desktop

# 直接运行（推荐放到 PATH 里）
./spy-your-desktop version
sudo install -m 0755 spy-your-desktop /usr/local/bin/spy-your-desktop
```

单文件不需要安装 Node.js 或 npm，也不需要额外运行库（glibc 系统即可）。

---

## 2. 服务端准备

Linux 客户端和 Windows 客户端共用同一个服务端，服务端不需要做任何改动。

1. 按主 README 部署 `Web` / `Web(new)`。
2. 在 `name-keys.json` 中给这个人的 key，例如：
   ```json
   {
     "澜轶": "your-secret-key"
   }
   ```
3. 在 `group-map.json` 中把这个人的设备 ID 加进去，例如：
   ```json
   {
     "澜轶": ["lanyi-desktop", "lanyi-linux"]
   }
   ```
   这里的 `lanyi-linux` 就是下一步要填的“设备 ID（machine-id）”。**设备 ID 和白名单不匹配会返回 403。**
4. 确认服务端能访问，例如：
   ```bash
   curl http://服务器IP:3000/api/health
   ```

> 上报地址要写完整，例如 `http://服务器IP:3000/api/ingest`。
> 不要把域名/IP+端口挂到 Nginx 的站点下面，要让 Node.js 直接监听端口（原项目 README 的要求）。

---

## 3. 首次配置

运行交互式向导：

```bash
spy-your-desktop init
```

按提示填写：

- 服务器上报地址：`http://服务器IP:3000/api/ingest`
- 设备 ID：必须出现在 `group-map.json` 对应名字的数组里
- 上传密钥：`name-keys.json` 中该名字对应的 key
- 监控间隔：默认 5 秒（服务端默认最小上报间隔 4 秒）
- 强制心跳：默认 10 秒

不想交互填也可以：

```bash
spy-your-desktop init \
  --server http://服务器IP:3000/api/ingest \
  --machine lanyi-linux \
  --key your-secret-key \
  --interval 5 \
  --heartbeat 10
```

查看配置（密钥会打码）：

```bash
spy-your-desktop show
```

配置文件默认保存在：

```
~/.config/spy-your-desktop/config.json
```

权限为 `0600`。日志默认在：

```
~/.local/state/spy-your-desktop/client.log
```

---

## 4. 验证连接

```bash
spy-your-desktop test
```

成功时会看到类似：

```
活动窗口来源：KWin (Wayland)
检测到：org.kde.konsole - 终端
上传成功：HTTP 200 {"ok":true}
```

然后打开网页查看是否出现该设备；也可以直接查接口：

```bash
curl 'http://服务器IP:3000/api/current-status?machine=lanyi-linux&limit=5'
```

常见错误：

| HTTP | 原因 | 处理 |
|------|------|------|
| 401 | key 不对 | 检查 `name-keys.json` 和 `--key` |
| 403 | 设备 ID 不在白名单 | 检查 `group-map.json` 中对应名字的数组 |
| 429 | 上报太频繁 | 等待几秒；客户端会自动退避 |
| 426 `update_notice` | 服务端一次性更新提示 | 正常现象，客户端会自动继续 |
| 426 `outdated_client` | 服务端版本策略拦截 | 检查服务端 `UPDATE_STRATEGY` / `LATEST_VERSION_OVERRIDE` |

> 服务端 `ONE_TIME_UPDATE_PROMPT_ENABLED=1` 时，每台机器第一次上报会收到一次 426 `update_notice`，客户端会打印提示并在下一轮继续，不会停止。

---

## 5. 运行与停止

### 后台运行（推荐）

```bash
spy-your-desktop start     # 后台启动
spy-your-desktop status    # 查看状态
spy-your-desktop stop      # 随时停止上传
spy-your-desktop restart   # 重启
```

### 前台运行

```bash
spy-your-desktop run
```

按 `Ctrl+C` 停止。前台运行会在终端打印每次上报内容。

### 开机自启动

```bash
spy-your-desktop autostart install
spy-your-desktop autostart status
spy-your-desktop autostart remove
```

它会在 `~/.config/autostart/` 写入桌面自启动文件，登录桌面后自动后台运行。该方式比 systemd user service 更可靠，因为能拿到完整的桌面会话环境（`WAYLAND_DISPLAY`、`DBUS_SESSION_BUS_ADDRESS`、`XDG_CURRENT_DESKTOP` 等）。

### 隐私模式（随时停止采集）

```bash
spy-your-desktop privacy on      # 只上报占位内容，不采集窗口标题/应用名
spy-your-desktop privacy off     # 恢复采集
spy-your-desktop privacy status
```

隐私模式开启后，上报内容固定为：

- `window_title`: `TA现在不想给你看QAQ`
- `app`: `private mode`

正在运行的客户端会在下一轮自动切换，不需要重启。想彻底停止上传请用 `spy-your-desktop stop`。

---

## 6. 桌面环境支持

程序启动时会根据 `XDG_SESSION_TYPE`、`XDG_CURRENT_DESKTOP` 和可用的 D-Bus 服务/命令自动选择来源。

### X11

支持通过 `xprop` 获取 `_NET_ACTIVE_WINDOW`、`_NET_WM_NAME`、`_NET_WM_PID`、`WM_CLASS`，必要时用 `xdotool` 兜底。

适用桌面：

- KDE Plasma X11
- GNOME / Ubuntu X11
- XFCE
- Cinnamon
- MATE
- LXQt
- Budgie
- i3 及其他 EWMH 兼容窗口管理器

如果提示缺少命令：

```bash
sudo apt install x11-utils xdotool
```

### Wayland

| 桌面 | 获取方式 | 说明 |
|------|----------|------|
| KDE Plasma（KWin） | KWin D-Bus Scripting | **本项目测试通过的组合**；客户端会临时加载一个只读脚本，通过 D-Bus 返回活动窗口标题/应用名，退出时卸载 |
| GNOME / Ubuntu | Focused Window D-Bus 扩展；Window Calls 扩展；Shell Introspect；unsafe-mode Eval | 新版 GNOME 默认限制 Introspect 的调用者，**建议安装 [Focused Window D-Bus](https://extensions.gnome.org/extension/5592/focused-window-d-bus/) 扩展**；未安装时只能回退到 XWayland 窗口 |
| Sway | `swaymsg -t get_tree` | 需要 `swaymsg` |
| i3（X11） | `xprop` / `i3-msg` | 优先 X11 方式 |
| Hyprland | `hyprctl activewindow -j` 或 Hyprland IPC socket | 需要 `hyprctl` 或 `HYPRLAND_INSTANCE_SIGNATURE` |
| Wayfire / labwc / river 等 wlroots 系 | `wlrctl toplevel list state:focused` | 需要 `wlrctl`，并非所有发行版都预装 |
| 其他 Wayland 桌面 | 自动回退尝试 | 如果桌面不提供活动窗口接口，只能使用 X11/XWayland 兜底，原生 Wayland 窗口可能无法识别 |

Wayland 的限制不是本项目能绕过的：活动窗口标题属于敏感信息，只有合成器（KWin/Mutter/wlroots）愿意提供时才能拿到。KDE 的 KWin Scripting 是官方提供的扩展接口；GNOME 需要 Shell 扩展；Sway/Hyprland 有各自 IPC。

### GNOME Wayland 安装扩展

1. 打开 <https://extensions.gnome.org/extension/5592/focused-window-d-bus/>
2. 安装并启用 “Focused Window D-Bus”
3. 重新运行 `spy-your-desktop test`

扩展没有安装时，客户端会打印警告，并可能只能看到 XWayland 应用。也可以在登录界面切换到 “GNOME on Xorg” 会话。

---

## 7. 从源码构建

要求：

- Node.js 20 或 22（仅构建时需要；运行单文件不需要 Node）
- npm
- `dpkg-deb`（构建 deb 时需要，Ubuntu/Debian 自带）
- Linux x86_64（默认；也支持 `./build.sh arm64` 交叉构建 arm64）

```bash
cd Linux
npm ci
npm test
npm run build
```

产物：

```
Linux/dist/spy-your-desktop
Linux/dist/spy-your-desktop_1.0.0_amd64.deb
Linux/dist/SHA256SUMS
```

`npm run build` 使用 `@yao-pkg/pkg` 把 Node.js 客户端和依赖打包成单个 ELF 可执行文件，再用 `dpkg-deb` 打成 deb。

arm64：

```bash
./build.sh arm64
```

---

## 8. 工作原理与权限

- 每 5 秒（可配置）读取一次活动窗口；标题或应用变化时立即上报，否则按心跳间隔上报。
- 标题超过 `maxTitleLen`（默认 150，和服务端默认 `MAX_TITLE_LEN` 一致）会先截断，避免服务端 400。
- 只发 `POST /api/ingest`，请求体与 Windows 客户端兼容：
  ```json
  {
    "machine": "lanyi-linux",
    "window_title": "终端",
    "app": "org.kde.konsole",
    "os": "Linux",
    "app_version": "1.0.0",
    "raw": { "source": "KWin (Wayland)", "pid": 1234, "reason": "change" }
  }
  ```
- 鉴权头：`Authorization: Bearer <key>`，同时带 `X-Name-Key`（与 Windows 客户端一致）。
- 不监听端口，不修改系统文件（除自己的配置、日志、pid、KWin 临时脚本和可选的 autostart 文件）。
- 建议使用普通用户运行，不要用 root，否则可能连不上桌面用户的 D-Bus 会话。

---

## 9. 卸载

```bash
spy-your-desktop stop
spy-your-desktop autostart remove
sudo apt remove spy-your-desktop
rm -rf ~/.config/spy-your-desktop ~/.local/state/spy-your-desktop
```

如果使用单文件安装，删除 `/usr/local/bin/spy-your-desktop` 即可。

---

## 10. 排查

### `没有可用的活动窗口获取方式`

程序会列出每种方式失败的原因。常见处理：

- KDE Wayland：确认 `org.kde.KWin` D-Bus 服务存在，并且客户端和桌面是同一个用户：
  ```bash
  gdbus introspect --session --dest org.kde.KWin --object-path /KWin
  ```
- GNOME Wayland：安装 Focused Window D-Bus 扩展，或改用 Xorg 会话。
- X11：安装 `x11-utils`，确认 `DISPLAY` 存在。
- Sway：确认 `SWAYSOCK` 存在且 `swaymsg -t get_tree` 能输出 JSON。
- Hyprland：确认 `hyprctl activewindow -j` 能输出 JSON。
- wlroots：安装 `wlrctl`。

### 日志

```bash
tail -f ~/.local/state/spy-your-desktop/client.log
```

### 配置错了

```bash
spy-your-desktop init --force
```

### 端口/服务端问题

客户端只负责上报。服务端监听、端口、防火墙、Nginx 反向代理请按主 README 和 `Web(new)/API.md` 处理。
