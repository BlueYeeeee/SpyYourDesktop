# SpyYourDesktop Linux Client

This is the standalone Linux reporter for SpyYourDesktop. It reuses the
existing server endpoint `POST /api/ingest`; **no server code or configuration
layout needs to change**.

It uploads only:

- the focused window title (`window_title`)
- the focused application name (`app`)
- machine ID, detection source, and PID (inside `raw`)

It never captures screenshots, keystrokes, clipboard contents, file contents,
or the text inside windows.

> **声明：Linux客户端只在Ubuntu 26.04的kde-wayland桌面环境测试通过** (Statement: the Linux client has only been tested on Ubuntu 26.04 with the KDE Wayland desktop). Other desktops, distributions, and architectures are untested.
>
> Wayland intentionally prevents normal applications from reading the global
> focused window. Each compositor exposes a different API; see the support
> table below.

---

## 1. Download and install

Download from this repository's Releases page:

- `spy-your-desktop` — extensionless single-file binary (amd64, recommended)
- `spy-your-desktop_1.0.0_amd64.deb` — Debian/Ubuntu package

### deb package

```bash
sudo apt install ./spy-your-desktop_1.0.0_amd64.deb
```

The command is installed as `/usr/bin/spy-your-desktop`.

### Single binary

```bash
chmod +x spy-your-desktop
./spy-your-desktop version
sudo install -m 0755 spy-your-desktop /usr/local/bin/spy-your-desktop
```

No Node.js, npm, or extra runtime is required at runtime.

---

## 2. Server preparation

Linux and Windows clients share the same server. No server changes are needed.

1. Deploy `Web` / `Web(new)` as described in the main README.
2. Add a key in `name-keys.json`:
   ```json
   { "YourName": "your-secret-key" }
   ```
3. Add the Linux machine ID to `group-map.json`:
   ```json
   { "YourName": ["your-windows-pc", "your-linux-pc"] }
   ```
4. Check the server:
   ```bash
   curl http://SERVER_IP:3000/api/health
   ```

The ingest URL must be complete, for example
`http://SERVER_IP:3000/api/ingest`.

---

## 3. First-time configuration

```bash
spy-your-desktop init
```

Fill in:

- server URL: `http://SERVER_IP:3000/api/ingest`
- machine ID: must match `group-map.json`
- upload key: must match `name-keys.json`
- interval: default 5 seconds (server default minimum is 4 seconds)
- heartbeat: default 10 seconds

Non-interactive:

```bash
spy-your-desktop init \
  --server http://SERVER_IP:3000/api/ingest \
  --machine your-linux-pc \
  --key your-secret-key \
  --interval 5 \
  --heartbeat 10
```

Config file: `~/.config/spy-your-desktop/config.json` (mode `0600`).  
Log file: `~/.local/state/spy-your-desktop/client.log`.

---

## 4. Test

```bash
spy-your-desktop test
```

Expected output includes:

```
活动窗口来源：KWin (Wayland)
检测到：org.kde.konsole - Terminal
上传成功：HTTP 200 {"ok":true}
```

Common errors:

| HTTP | Meaning | Fix |
|------|---------|-----|
| 401 | invalid key | check `name-keys.json` / `--key` |
| 403 | machine not whitelisted | check `group-map.json` |
| 429 | too frequent | wait; the client backs off automatically |
| 426 `update_notice` | one-time server update notice | normal; the client continues |
| 426 `outdated_client` | server version policy | check `UPDATE_STRATEGY` / `LATEST_VERSION_OVERRIDE` |

---

## 5. Run, stop, privacy

```bash
spy-your-desktop start       # background
spy-your-desktop status
spy-your-desktop stop        # stop uploading at any time
spy-your-desktop restart
spy-your-desktop run         # foreground; Ctrl+C stops
```

Autostart at desktop login:

```bash
spy-your-desktop autostart install
spy-your-desktop autostart status
spy-your-desktop autostart remove
```

Privacy mode:

```bash
spy-your-desktop privacy on      # upload placeholder only
spy-your-desktop privacy off
spy-your-desktop privacy status
```

When privacy mode is on, the uploaded title is
`TA现在不想给你看QAQ` and the app is `private mode`. A running client switches
on the next tick. Use `stop` to stop uploading completely.

---

## 6. Desktop support

### X11

Uses `xprop` (`_NET_ACTIVE_WINDOW`, `_NET_WM_NAME`, `_NET_WM_PID`, `WM_CLASS`)
with optional `xdotool` fallback. Works with KDE Plasma X11, GNOME X11, XFCE,
Cinnamon, MATE, LXQt, Budgie, i3, and other EWMH-compatible window managers.

```bash
sudo apt install x11-utils xdotool
```

### Wayland

| Desktop | Method | Notes |
|---------|--------|-------|
| KDE Plasma (KWin) | KWin D-Bus Scripting | **Tested combination**; a temporary read-only script reports the active window and is unloaded on exit |
| GNOME / Ubuntu | Focused Window D-Bus extension; Window Calls extension; Shell Introspect; unsafe-mode Eval | Recent GNOME restricts Introspect callers. Install [Focused Window D-Bus](https://extensions.gnome.org/extension/5592/focused-window-d-bus/) or use an Xorg session |
| Sway | `swaymsg -t get_tree` | requires `swaymsg` |
| i3 (X11) | `xprop` / `i3-msg` | X11 path preferred |
| Hyprland | `hyprctl activewindow -j` or its IPC socket | requires `hyprctl` or `HYPRLAND_INSTANCE_SIGNATURE` |
| Wayfire / labwc / river (wlroots) | `wlrctl toplevel list state:focused` | requires `wlrctl` |
| Other Wayland desktops | automatic fallbacks | without a compositor API only XWayland windows can be seen |

Wayland's restriction is by design; the client cannot bypass it. KWin scripting
is KDE's official extension interface, GNOME needs a Shell extension, and
Sway/Hyprland provide their own IPC.

---

## 7. Build from source

Requirements: Node.js 20/22 (build only), npm, `dpkg-deb`.

```bash
cd Linux
npm ci
npm test
npm run build
```

Outputs:

```
Linux/dist/spy-your-desktop
Linux/dist/spy-your-desktop_1.0.0_amd64.deb
Linux/dist/SHA256SUMS
```

For arm64:

```bash
./build.sh arm64
```

`npm run build` uses `@yao-pkg/pkg` to bundle the Node.js client and its
dependencies into one ELF binary, then creates the deb package with
`dpkg-deb`.

---

## 8. Behavior and permissions

- Samples the focused window every 5 seconds (configurable).
- Uploads on title/app change, otherwise at the heartbeat interval.
- Truncates titles to `maxTitleLen` (default 150, matching the server default).
- Sends `POST /api/ingest` with the same fields as the Windows client.
- Uses `Authorization: Bearer <key>` and `X-Name-Key`.
- Opens no listening port.
- Writes only its own config, state, pid, temporary KWin script, and an
  optional autostart file.
- Run as a normal desktop user, not root.

---

## 9. Uninstall

```bash
spy-your-desktop stop
spy-your-desktop autostart remove
sudo apt remove spy-your-desktop
rm -rf ~/.config/spy-your-desktop ~/.local/state/spy-your-desktop
```

---

## 10. Troubleshooting

- Run with `--log-level debug` for detection details.
- Check `~/.local/state/spy-your-desktop/client.log`.
- KDE Wayland: verify the D-Bus service:
  ```bash
  gdbus introspect --session --dest org.kde.KWin --object-path /KWin
  ```
- GNOME Wayland: install the Focused Window D-Bus extension or use Xorg.
- X11: install `x11-utils` and check `DISPLAY`.
- Sway: check `SWAYSOCK` and `swaymsg -t get_tree`.
- Hyprland: check `hyprctl activewindow -j`.
- wlroots: install `wlrctl`.

For server deployment, ports, firewall, and Nginx, follow the main README and
`Web(new)/API.md`.
