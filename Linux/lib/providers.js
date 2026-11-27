'use strict';

const fs = require('fs');
const net = require('net');
const path = require('path');

const dbus = require('dbus-next');

const {
  run,
  commandExists,
  parseXpropActiveWindow,
  parseXpropWindow,
  parseSwayTree,
  parseHyprlandWindow,
  parseWlrctlList,
  readFileSafe,
} = require('./util');

const KWIN_BUS_NAME = 'io.github.qq1816.SpyYourDesktop';
const KWIN_IFACE = 'io.github.qq1816.SpyYourDesktop';
const KWIN_OBJ_PATH = '/io/github/qq1816/SpyYourDesktop';
const KWIN_SCRIPT_NAME = 'spy-your-desktop-active-window';

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function detectSession() {
  const type = String(process.env.XDG_SESSION_TYPE || '').toLowerCase();
  const wayland = type === 'wayland' || (!type && !!process.env.WAYLAND_DISPLAY) || !!process.env.WAYLAND_DISPLAY;
  const x11 = !wayland && (type === 'x11' || !!process.env.DISPLAY);
  const desktop = String(
    process.env.XDG_CURRENT_DESKTOP || process.env.DESKTOP_SESSION || ''
  ).toLowerCase();
  const isKde = desktop.indexOf('kde') >= 0 || desktop.indexOf('plasma') >= 0;
  const isGnome =
    desktop.indexOf('gnome') >= 0 ||
    desktop.indexOf('ubuntu') >= 0 ||
    desktop.indexOf('unity') >= 0;
  const isSway = desktop.indexOf('sway') >= 0 || !!process.env.SWAYSOCK;
  const isHyprland =
    desktop.indexOf('hyprland') >= 0 || !!process.env.HYPRLAND_INSTANCE_SIGNATURE;

  return {
    type: wayland ? 'wayland' : x11 ? 'x11' : 'unknown',
    wayland,
    x11,
    desktop: desktop || '(unknown)',
    isKde,
    isGnome,
    isSway,
    isHyprland,
    display: process.env.DISPLAY || null,
    waylandDisplay: process.env.WAYLAND_DISPLAY || null,
  };
}

function describeSession(session) {
  const parts = [session.type];
  if (session.desktop !== '(unknown)') parts.push(session.desktop);
  if (session.waylandDisplay) parts.push('WAYLAND_DISPLAY=' + session.waylandDisplay);
  if (session.display) parts.push('DISPLAY=' + session.display);
  return parts.join(' / ');
}

function unwrapVariant(value) {
  let v = value;
  for (let i = 0; i < 5; i++) {
    if (!v || typeof v !== 'object') return v;
    if (typeof v.value !== 'undefined' && (v.signature || v.constructor && v.constructor.name === 'Variant')) {
      v = v.value;
      continue;
    }
    return v;
  }
  return v;
}

function parseGnomeJson(text) {
  if (text == null) return null;
  let data = text;
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch (_) {
      return null;
    }
  }
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch (_) {
      return null;
    }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const title = data.title != null ? String(data.title) : '';
  const app =
    data.wm_class != null
      ? String(data.wm_class)
      : data.wmClass != null
        ? String(data.wmClass)
        : data.app_id != null
          ? String(data.app_id)
          : '';
  const pid = Number(data.pid) || 0;
  if (!title && !app) return null;
  return { title, app, pid };
}

class KWinProvider {
  constructor(ctx) {
    this.sctx = ctx;
    this.log = ctx.log;
    this.bus = null;
    this.cache = null;
    this.scriptPath = null;
    this.name = 'KWin (Wayland)';
    this.note = null;
  }

  async init() {
    this.bus = dbus.sessionBus();
    this.bus.on('error', (e) => {
      this.log.debug('[kwin] session bus error:', e && e.message ? e.message : e);
    });

    const self = this;
    class UpdateInterface extends dbus.interface.Interface {
      Update(payload) {
        self._onUpdate(payload);
      }
    }
    UpdateInterface.configureMembers({
      methods: {
        Update: { inSignature: 's', outSignature: '' },
      },
    });
    this.interface = new UpdateInterface(KWIN_IFACE);
    this.bus.export(KWIN_OBJ_PATH, this.interface);

    const reply = await this.bus.requestName(KWIN_BUS_NAME, 0);
    if (reply !== 1 && reply !== 4) {
      throw new Error('无法注册 D-Bus 服务名 ' + KWIN_BUS_NAME + '（返回码 ' + reply + '）');
    }

    const script = [
      '(function () {',
      '  var SERVICE = ' + JSON.stringify(KWIN_BUS_NAME) + ';',
      '  var PATH = ' + JSON.stringify(KWIN_OBJ_PATH) + ';',
      '  var IFACE = ' + JSON.stringify(KWIN_IFACE) + ';',
      '  var cur = null;',
      '  function collect() {',
      '    var w = null;',
      '    try { w = workspace.activeWindow || workspace.activeClient || null; } catch (e) { w = null; }',
      '    if (!w) return { title: "", app: "", pid: 0 };',
      '    var title = "", app = "", pid = 0;',
      '    try { title = w.caption || ""; } catch (e) {}',
      '    try { app = w.resourceClass || w.resourceName || ""; } catch (e) {}',
      '    try { pid = w.pid || 0; } catch (e) {}',
      '    return { title: title, app: app, pid: pid };',
      '  }',
      '  function send() {',
      '    try {',
      '      callDBus(SERVICE, PATH, IFACE, "Update", JSON.stringify(collect()));',
      '    } catch (e) {}',
      '  }',
      '  function watch(w) {',
      '    if (cur === w) { send(); return; }',
      '    if (cur) { try { cur.captionChanged.disconnect(send); } catch (e) {} }',
      '    cur = w;',
      '    if (cur) { try { cur.captionChanged.connect(send); } catch (e) {} }',
      '    send();',
      '  }',
      '  var ws = workspace;',
      '  if (ws.windowActivated) { ws.windowActivated.connect(watch); }',
      '  else if (ws.clientActivated) { ws.clientActivated.connect(watch); }',
      '  watch(ws.activeWindow || ws.activeClient || null);',
      '  try { setInterval(send, 2000); } catch (e) {}',
      '})();',
      '',
    ].join('\n');

    const cacheDir = path.join(this.sctx.paths.stateDir, 'kwin');
    fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
    this.scriptPath = path.join(cacheDir, 'active-window.js');
    fs.writeFileSync(this.scriptPath, script, { encoding: 'utf8', mode: 0o600 });

    const scriptingObj = await this.bus.getProxyObject('org.kde.KWin', '/Scripting');
    const scripting = scriptingObj.getInterface('org.kde.kwin.Scripting');

    try {
      await scripting.unloadScript(KWIN_SCRIPT_NAME);
    } catch (_) {
      // no old script
    }

    // dbus-next does not handle the overloaded loadScript(s) / loadScript(ss)
    // method well, so issue the two-argument variant manually.
    const loadReply = await this.bus.call(
      new dbus.Message({
        destination: 'org.kde.KWin',
        path: '/Scripting',
        interface: 'org.kde.kwin.Scripting',
        member: 'loadScript',
        signature: 'ss',
        body: [this.scriptPath, KWIN_SCRIPT_NAME],
      })
    );
    const scriptId = loadReply && loadReply.body ? loadReply.body[0] : -1;
    if (scriptId == null || scriptId < 0) {
      throw new Error('KWin 拒绝加载窗口探测脚本');
    }

    const scriptObj = await this.bus.getProxyObject(
      'org.kde.KWin',
      '/Scripting/Script' + scriptId
    );
    const scriptIface = scriptObj.getInterface('org.kde.kwin.Script');
    await scriptIface.run();

    const deadline = Date.now() + 3000;
    while (!this.cache && Date.now() < deadline) {
      await delay(80);
    }
    if (!this.cache) {
      throw new Error('KWin 脚本已加载，但没有返回活动窗口信息');
    }
    this.note =
      'KWin D-Bus 脚本已启用（仅采集活动窗口标题/应用名，不保存窗口内容）';
  }

  _onUpdate(payload) {
    try {
      const value = unwrapVariant(payload);
      const obj = typeof value === 'string' ? JSON.parse(value) : value;
      if (!obj || typeof obj !== 'object') return;
      this.cache = {
        title: obj.title == null ? '' : String(obj.title),
        app: obj.app == null ? '' : String(obj.app),
        pid: Number(obj.pid) || 0,
      };
    } catch (e) {
      this.log.debug('[kwin] invalid update payload:', e.message);
    }
  }

  async getActiveWindow() {
    if (!this.cache) return null;
    return {
      title: this.cache.title,
      app: this.cache.app,
      pid: this.cache.pid,
    };
  }

  async destroy() {
    if (!this.bus) return;
    try {
      const scriptingObj = await this.bus.getProxyObject('org.kde.KWin', '/Scripting');
      const scripting = scriptingObj.getInterface('org.kde.kwin.Scripting');
      await scripting.unloadScript(KWIN_SCRIPT_NAME);
    } catch (_) {
      // KWin may be shutting down
    }
    try {
      const cacheDir = path.join(this.sctx.paths.stateDir, 'kwin');
      const p = path.join(cacheDir, 'active-window.js');
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch (_) {
      // ignore
    }
    try {
      this.bus.disconnect();
    } catch (_) {
      // ignore
    }
    this.bus = null;
  }
}

class GnomeProvider {
  constructor(ctx) {
    this.sctx = ctx;
    this.log = ctx.log;
    this.bus = null;
    this.mode = null;
    this.name = 'GNOME Shell (Wayland)';
    this.note = null;
  }

  async init() {
    this.bus = dbus.sessionBus();
    this.bus.on('error', (e) => {
      this.log.debug('[gnome] session bus error:', e && e.message ? e.message : e);
    });
    const info = await this._detect();
    if (this.mode === 'introspect' || this.mode === 'eval') {
      this.note =
        'GNOME Wayland 通过 ' +
        (this.mode === 'introspect' ? 'Shell Introspect' : 'unsafe-mode Eval') +
        ' 获取焦点窗口';
    } else if (this.mode) {
      this.note = 'GNOME Wayland 通过 Shell 扩展获取焦点窗口';
    }
    return info;
  }

  async _callObject(dest, objPath, ifaceName, method, args) {
    const obj = await this.bus.getProxyObject(dest, objPath);
    const iface = obj.getInterface(ifaceName);
    if (!iface || typeof iface[method] !== 'function') {
      throw new Error('D-Bus 接口缺少方法：' + ifaceName + '.' + method);
    }
    return iface[method].apply(iface, args || []);
  }

  async _focusedExtension() {
    const text = await this._callObject(
      'org.gnome.Shell',
      '/org/gnome/shell/extensions/FocusedWindow',
      'org.gnome.shell.extensions.FocusedWindow',
      'Get'
    );
    return parseGnomeJson(text);
  }

  async _windowCalls() {
    const text = await this._callObject(
      'org.gnome.Shell',
      '/org/gnome/Shell/Extensions/Windows',
      'org.gnome.Shell.Extensions.Windows',
      'List'
    );
    let list = text;
    if (typeof list === 'string') list = JSON.parse(list);
    if (!Array.isArray(list)) return null;
    const hit = list.find((w) => w && w.focus === true);
    if (!hit) return null;
    return {
      title: hit.title == null ? '' : String(hit.title),
      app: hit.wm_class == null ? '' : String(hit.wm_class),
      pid: Number(hit.pid) || 0,
    };
  }

  async _introspect() {
    const windows = await this._callObject(
      'org.gnome.Shell.Introspect',
      '/org/gnome/Shell/Introspect',
      'org.gnome.Shell.Introspect',
      'GetWindows'
    );
    const obj = unwrapVariant(windows);
    if (!obj || typeof obj !== 'object') return null;
    for (const key of Object.keys(obj)) {
      const props = unwrapVariant(obj[key]);
      if (!props || typeof props !== 'object') continue;
      const hasFocus =
        unwrapVariant(props['has-focus']) === true ||
        unwrapVariant(props.hasFocus) === true;
      if (!hasFocus) continue;
      const title = unwrapVariant(props.title);
      const app =
        unwrapVariant(props['app-id']) != null
          ? unwrapVariant(props['app-id'])
          : unwrapVariant(props['wm-class']);
      if (title == null && app == null) return null;
      return {
        title: title == null ? '' : String(title),
        app: app == null ? '' : String(app),
        pid: 0,
      };
    }
    return null;
  }

  async _eval() {
    const expression =
      'JSON.stringify((function(){var a=global.get_window_actors().filter(function(x){return x.meta_window.has_focus();})[0];' +
      'if(!a)return null;return {title:a.meta_window.get_title(),app:a.meta_window.get_wm_class(),pid:a.meta_window.get_pid()};})())';
    const res = await this._callObject(
      'org.gnome.Shell',
      '/org/gnome/Shell',
      'org.gnome.Shell',
      'Eval',
      [expression]
    );
    if (!Array.isArray(res) || res[0] !== true) {
      throw new Error('GNOME Shell Eval 被禁用（需要打开 unsafe mode）');
    }
    return parseGnomeJson(res[1]);
  }

  async _detect() {
    const errors = [];
    if (!this.mode || this.mode === 'focused-extension') {
      try {
        const info = await this._focusedExtension();
        this.mode = 'focused-extension';
        return info;
      } catch (e) {
        errors.push('FocusedWindow 扩展: ' + e.message);
        if (this.mode === 'focused-extension') this.mode = null;
      }
    }
    if (!this.mode || this.mode === 'window-calls') {
      try {
        const info = await this._windowCalls();
        this.mode = 'window-calls';
        return info;
      } catch (e) {
        errors.push('Window Calls 扩展: ' + e.message);
        if (this.mode === 'window-calls') this.mode = null;
      }
    }
    if (!this.mode || this.mode === 'introspect') {
      try {
        const info = await this._introspect();
        this.mode = 'introspect';
        return info;
      } catch (e) {
        errors.push('Shell Introspect: ' + e.message);
        if (this.mode === 'introspect') this.mode = null;
      }
    }
    if (!this.mode || this.mode === 'eval') {
      try {
        const info = await this._eval();
        this.mode = 'eval';
        return info;
      } catch (e) {
        errors.push('Shell Eval: ' + e.message);
        if (this.mode === 'eval') this.mode = null;
      }
    }
    const err = new Error(
      'GNOME Wayland 无法读取焦点窗口。请安装 “Focused Window D-Bus” 扩展，或改用 X11 会话。\n' +
        errors.join('\n')
    );
    err.gnomeUnavailable = true;
    throw err;
  }

  async getActiveWindow() {
    return this._detect();
  }

  async destroy() {
    if (!this.bus) return;
    try {
      this.bus.disconnect();
    } catch (_) {
      // ignore
    }
    this.bus = null;
  }
}

class SwayProvider {
  constructor(ctx) {
    this.sctx = ctx;
    this.log = ctx.log;
    this.cmd = null;
    this.name = 'Sway/i3 (Wayland)';
  }

  async init() {
    let cmd = null;
    if (process.env.SWAYSOCK && commandExists('swaymsg')) cmd = 'swaymsg';
    else if (process.env.I3SOCK && commandExists('i3-msg')) cmd = 'i3-msg';
    else if (commandExists('swaymsg')) cmd = 'swaymsg';
    else if (commandExists('i3-msg')) cmd = 'i3-msg';
    if (!cmd) throw new Error('需要 swaymsg 或 i3-msg 命令');
    this.cmd = cmd;
  }

  async getActiveWindow() {
    const out = await run(this.cmd, ['-t', 'get_tree'], { timeout: 3000 });
    return parseSwayTree(out);
  }

  async destroy() {}
}

class HyprlandProvider {
  constructor(ctx) {
    this.sctx = ctx;
    this.log = ctx.log;
    this.useSocket = false;
    this.socketPath = null;
    this.name = 'Hyprland (Wayland)';
  }

  async init() {
    if (commandExists('hyprctl')) {
      this.useSocket = false;
      return;
    }
    const sig = process.env.HYPRLAND_INSTANCE_SIGNATURE;
    if (!sig) throw new Error('需要 hyprctl 命令或 HYPRLAND_INSTANCE_SIGNATURE');
    const runtime = process.env.XDG_RUNTIME_DIR || '/run/user/' + process.getuid();
    this.socketPath = path.join(runtime, 'hypr', sig, '.socket.sock');
    if (!fs.existsSync(this.socketPath)) {
      throw new Error('找不到 Hyprland IPC socket：' + this.socketPath);
    }
    this.useSocket = true;
  }

  _querySocket() {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let settled = false;
      const client = net.createConnection(this.socketPath);
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        client.destroy();
        reject(new Error('Hyprland IPC 超时'));
      }, 3000);
      client.on('connect', () => {
        client.write('j/activewindow');
      });
      client.on('data', (chunk) => chunks.push(chunk));
      client.on('end', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(Buffer.concat(chunks).toString('utf8'));
      });
      client.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  async getActiveWindow() {
    let out;
    if (this.useSocket) out = await this._querySocket();
    else out = await run('hyprctl', ['activewindow', '-j'], { timeout: 3000 });
    return parseHyprlandWindow(out);
  }

  async destroy() {}
}

class WlrctlProvider {
  constructor(ctx) {
    this.sctx = ctx;
    this.log = ctx.log;
    this.name = 'wlroots (wlrctl)';
  }

  async init() {
    if (!commandExists('wlrctl')) {
      throw new Error('需要 wlrctl（sudo apt install wlrctl）');
    }
  }

  async getActiveWindow() {
    const out = await run('wlrctl', ['toplevel', 'list', 'state:focused'], {
      timeout: 3000,
    });
    return parseWlrctlList(out);
  }

  async destroy() {}
}

class X11Provider {
  constructor(ctx) {
    this.sctx = ctx;
    this.log = ctx.log;
    this.xprop = false;
    this.xdotool = false;
    this.name = 'X11';
    this.note = null;
  }

  async init() {
    if (!process.env.DISPLAY) throw new Error('DISPLAY 未设置');
    this.xprop = commandExists('xprop');
    this.xdotool = commandExists('xdotool');
    if (!this.xprop && !this.xdotool) {
      throw new Error('需要 xprop 或 xdotool（sudo apt install x11-utils xdotool）');
    }
    if (this.sctx.session.wayland) {
      this.name = 'X11/XWayland';
      this.note =
        '当前是 Wayland 会话，X11 方式只能看到 XWayland 窗口；原生 Wayland 窗口需要对应的桌面专用方式';
    }
  }

  _decimalId(id) {
    if (/^0x/i.test(id)) return String(parseInt(id, 16));
    return String(id);
  }

  async _activeWindowId() {
    if (this.xprop) {
      try {
        const out = await run('xprop', ['-root', '-notype', '_NET_ACTIVE_WINDOW'], {
          timeout: 2500,
        });
        const id = parseXpropActiveWindow(out);
        if (id) return id;
      } catch (e) {
        this.log.debug('[x11] xprop active window failed:', e.message);
      }
    }
    if (this.xdotool) {
      try {
        const out = await run('xdotool', ['getactivewindow'], { timeout: 2500 });
        const n = parseInt(String(out).trim(), 10);
        if (Number.isFinite(n) && n > 0) return '0x' + n.toString(16);
      } catch (e) {
        this.log.debug('[x11] xdotool active window failed:', e.message);
      }
    }
    return null;
  }

  async getActiveWindow() {
    const id = await this._activeWindowId();
    if (!id) return null;

    let info = { title: '', app: '', pid: 0 };

    if (this.xprop) {
      try {
        const out = await run(
          'xprop',
          ['-id', id, '-notype', '_NET_WM_NAME', 'WM_NAME', '_NET_WM_PID', 'WM_CLASS'],
          { timeout: 2500 }
        );
        info = Object.assign(info, parseXpropWindow(out));
      } catch (e) {
        this.log.debug('[x11] xprop window properties failed:', e.message);
      }
    }

    const decId = this._decimalId(id);
    if (this.xdotool) {
      if (!info.title) {
        try {
          const t = await run('xdotool', ['getwindowname', decId], { timeout: 2500 });
          info.title = String(t || '').replace(/\r?\n$/, '');
        } catch (e) {
          this.log.debug('[x11] xdotool title failed:', e.message);
        }
      }
      if (!info.pid) {
        try {
          const p = await run('xdotool', ['getwindowpid', decId], { timeout: 2500 });
          const n = parseInt(String(p).trim(), 10);
          if (Number.isFinite(n)) info.pid = n;
        } catch (e) {
          this.log.debug('[x11] xdotool pid failed:', e.message);
        }
      }
    }

    if (!info.app && info.pid) {
      const comm = readFileSafe('/proc/' + info.pid + '/comm');
      if (comm) info.app = comm.trim();
    }
    if (!info.title && !info.app) return null;
    return {
      title: info.title || '',
      app: info.app || '',
      pid: Number(info.pid) || 0,
    };
  }

  async destroy() {}
}

function buildCandidates(sctx) {
  const s = sctx.session;
  const list = [];
  const add = (label, factory) => {
    if (list.some((x) => x.label === label)) return;
    list.push({ label, factory });
  };

  if (s.type === 'wayland') {
    if (s.isKde) add('KWin', () => new KWinProvider(sctx));
    if (s.isGnome) add('GNOME', () => new GnomeProvider(sctx));
    if (s.isHyprland) add('Hyprland', () => new HyprlandProvider(sctx));
    if (s.isSway) add('Sway', () => new SwayProvider(sctx));
    if (!s.isKde && !s.isGnome) {
      // The environment may not expose a desktop name, so try the two
      // most common Wayland compositors before the generic fallbacks.
      add('KWin', () => new KWinProvider(sctx));
      add('GNOME', () => new GnomeProvider(sctx));
    }
    add('wlrctl', () => new WlrctlProvider(sctx));
    if (s.display) add('X11', () => new X11Provider(sctx));
  } else if (s.type === 'x11') {
    add('X11', () => new X11Provider(sctx));
    if (process.env.I3SOCK) add('i3', () => new SwayProvider(sctx));
    if (process.env.DISPLAY) add('wlrctl', () => new WlrctlProvider(sctx));
  } else {
    add('KWin', () => new KWinProvider(sctx));
    add('GNOME', () => new GnomeProvider(sctx));
    add('Hyprland', () => new HyprlandProvider(sctx));
    add('Sway', () => new SwayProvider(sctx));
    add('X11', () => new X11Provider(sctx));
    add('wlrctl', () => new WlrctlProvider(sctx));
  }
  return list;
}

class Detector {
  constructor(sctx) {
    this.sctx = sctx;
    this.log = sctx.log;
    this.session = sctx.session;
    this.candidates = buildCandidates(sctx);
    this.provider = null;
    this.providerLabel = null;
    this.failures = 0;
    this.lastWarnAt = 0;
    this.lastErrorText = '';
  }

  async start() {
    await this.stop();
    const failures = [];
    for (const candidate of this.candidates) {
      let provider = null;
      try {
        this.log.debug('[detect] 尝试 ' + candidate.label + ' ...');
        provider = candidate.factory();
        await provider.init();
        const info = await provider.getActiveWindow();
        this.provider = provider;
        this.providerLabel = provider.name;
        this.failures = 0;
        if (failures.length) {
          this.log.debug(
            '[detect] 已跳过不可用方式：' + failures.map((x) => x.label).join(', ')
          );
        }
        if (provider.note) this.log.info(provider.note);
        this.log.info('活动窗口来源：' + provider.name);
        return info ? Object.assign({}, info, { source: provider.name }) : null;
      } catch (e) {
        if (provider) {
          try {
            await provider.destroy();
          } catch (_) {
            // ignore
          }
        }
        failures.push({ label: candidate.label, message: e.message });
        this.log.debug('[detect] ' + candidate.label + ' 不可用：' + e.message);
      }
    }
    const err = new Error(
      '没有可用的活动窗口获取方式。\n' +
        failures.map((f) => '- ' + f.label + ': ' + f.message).join('\n') +
        '\n\n提示：Wayland 受桌面安全限制，请确认桌面环境；X11 请安装 x11-utils。'
    );
    err.detectionFailures = failures;
    throw err;
  }

  async getActiveWindow() {
    if (!this.provider) {
      return this.start();
    }
    try {
      const info = await this.provider.getActiveWindow();
      this.failures = 0;
      if (!info) return null;
      return Object.assign({}, info, { source: this.providerLabel });
    } catch (e) {
      this.failures++;
      const now = Date.now();
      const text = e.message || String(e);
      if (now - this.lastWarnAt > 30000 || text !== this.lastErrorText) {
        this.lastWarnAt = now;
        this.lastErrorText = text;
        this.log.warn(
          '读取活动窗口失败（' + this.providerLabel + '）：' + text
        );
      }
      if (this.failures >= 3) {
        this.log.warn('活动窗口来源连续失败，重新探测...');
        this.failures = 0;
        const oldName = this.providerLabel;
        await this.stop();
        const info = await this.start();
        if (oldName && this.providerLabel !== oldName) {
          this.log.info('已切换活动窗口来源：' + oldName + ' -> ' + this.providerLabel);
        }
        return info ? Object.assign({}, info, { source: this.providerLabel }) : null;
      }
      throw e;
    }
  }

  async stop() {
    if (this.provider) {
      try {
        await this.provider.destroy();
      } catch (e) {
        this.log.debug('关闭窗口来源失败：' + e.message);
      }
    }
    this.provider = null;
    this.providerLabel = null;
  }
}

module.exports = {
  detectSession,
  describeSession,
  Detector,
  KWinProvider,
  GnomeProvider,
  SwayProvider,
  HyprlandProvider,
  WlrctlProvider,
  X11Provider,
};
