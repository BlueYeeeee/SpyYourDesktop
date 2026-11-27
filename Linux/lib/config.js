'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const APP_DIR_NAME = 'spy-your-desktop';

function baseConfigDir() {
  if (process.env.SPY_CONFIG_DIR) return path.resolve(process.env.SPY_CONFIG_DIR);
  const xdg = process.env.XDG_CONFIG_HOME;
  return path.join(xdg && xdg.trim() ? xdg : path.join(os.homedir(), '.config'), APP_DIR_NAME);
}

function baseStateDir() {
  if (process.env.SPY_STATE_DIR) return path.resolve(process.env.SPY_STATE_DIR);
  const xdg = process.env.XDG_STATE_HOME;
  return path.join(xdg && xdg.trim() ? xdg : path.join(os.homedir(), '.local', 'state'), APP_DIR_NAME);
}

function paths() {
  const configDir = baseConfigDir();
  const stateDir = baseStateDir();
  return {
    configDir,
    stateDir,
    configPath: process.env.SPY_CONFIG_FILE
      ? path.resolve(process.env.SPY_CONFIG_FILE)
      : path.join(configDir, 'config.json'),
    pidPath: path.join(stateDir, 'client.pid'),
    logPath: path.join(stateDir, 'client.log'),
    privacyPath: path.join(stateDir, 'privacy.on'),
  };
}

function defaultConfig() {
  return {
    serverUrl: 'http://127.0.0.1:3000/api/ingest',
    machineId: '',
    uploadKey: '',
    intervalSec: 5,
    heartbeatSec: 10,
    maxTitleLen: 150,
  };
}

function normalizeServerUrl(raw) {
  let s = String(raw == null ? '' : raw).trim();
  if (!s) throw new Error('服务器地址不能为空');
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
  let u;
  try {
    u = new URL(s);
  } catch (_) {
    throw new Error('服务器地址不是合法的 URL：' + raw);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('服务器地址必须以 http:// 或 https:// 开头');
  }
  if (!u.hostname) throw new Error('服务器地址缺少主机名');
  if (!u.pathname || u.pathname === '/') u.pathname = '/api/ingest';
  if (u.pathname === '/api') u.pathname = '/api/ingest';
  u.hash = '';
  let out = u.toString();
  out = out.replace(/\/+$/, '');
  return out;
}

function normalizeMachineId(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) throw new Error('设备 ID 不能为空');
  if (s.length > 200) throw new Error('设备 ID 不能超过 200 个字符');
  if (/[\u0000-\u001f\u007f]/.test(s)) throw new Error('设备 ID 不能包含控制字符');
  return s;
}

function normalizeConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const cfg = defaultConfig();
  cfg.serverUrl = normalizeServerUrl(src.serverUrl || cfg.serverUrl);
  cfg.machineId = src.machineId == null ? '' : String(src.machineId).trim();
  cfg.uploadKey = src.uploadKey == null ? '' : String(src.uploadKey).trim();
  cfg.intervalSec = Math.max(5, Math.min(3600, parseInt(src.intervalSec, 10) || 5));
  cfg.heartbeatSec = Math.max(10, Math.min(3600, parseInt(src.heartbeatSec, 10) || 10));
  cfg.maxTitleLen = Math.max(10, Math.min(4096, parseInt(src.maxTitleLen, 10) || 150));
  if (cfg.machineId) cfg.machineId = normalizeMachineId(cfg.machineId);
  return cfg;
}

function loadConfig(options) {
  const opts = options || {};
  const p = opts.configPath || paths().configPath;
  if (!fs.existsSync(p)) {
    if (opts.required === false) return null;
    throw new Error(
      '找不到配置文件：' + p + '\n请先运行：spy-your-desktop init'
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    throw new Error('配置文件不是合法 JSON：' + p + '\n' + e.message);
  }
  const cfg = normalizeConfig(parsed);
  if (!cfg.machineId) {
    throw new Error('配置文件缺少 machineId：' + p + '\n请运行：spy-your-desktop init');
  }
  return cfg;
}

function saveConfig(cfg, configPath) {
  const p = configPath || paths().configPath;
  const normalized = normalizeConfig(cfg);
  if (!normalized.machineId) throw new Error('设备 ID 不能为空');
  const dir = path.dirname(p);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = p + '.tmp-' + process.pid;
  const json = JSON.stringify(normalized, null, 2) + '\n';
  fs.writeFileSync(tmp, json, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, p);
  try {
    fs.chmodSync(p, 0o600);
  } catch (_) {
    // best effort
  }
  return normalized;
}

function maskKey(key) {
  const s = String(key || '');
  if (!s) return '(未设置)';
  if (s.length <= 8) return '********';
  return s.slice(0, 2) + '****' + s.slice(-2) + ' (' + s.length + ' 字符)';
}

function defaultMachineId() {
  const name = String(os.hostname() || 'linux').trim();
  const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned || 'linux-desktop';
}

function privacyFlagEnabled() {
  try {
    return fs.existsSync(paths().privacyPath);
  } catch (_) {
    return false;
  }
}

function setPrivacyFlag(enabled) {
  const p = paths().privacyPath;
  const dir = path.dirname(p);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (enabled) {
    fs.writeFileSync(p, '1\n', { encoding: 'utf8', mode: 0o600 });
  } else {
    try {
      fs.unlinkSync(p);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }
}

function autostartPath() {
  const xdg = process.env.XDG_CONFIG_HOME;
  const dir = path.join(xdg && xdg.trim() ? xdg : path.join(os.homedir(), '.config'), 'autostart');
  return path.join(dir, 'spy-your-desktop.desktop');
}

function quoteDesktopExecArg(value) {
  return (
    '"' +
    String(value)
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/`/g, '\\`')
      .replace(/\$/g, '\\$') +
    '"'
  );
}

function writeAutostart(execLine) {
  const p = autostartPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const exec = String(execLine || '').trim();
  if (!exec) throw new Error('autostart Exec 命令不能为空');
  const body = [
    '[Desktop Entry]',
    'Type=Application',
    'Version=1.0',
    'Name=SpyYourDesktop',
    'Comment=Upload the current window title to your SpyYourDesktop server',
    'Exec=' + exec,
    'Terminal=false',
    'NoDisplay=true',
    'X-GNOME-Autostart-enabled=true',
    'X-KDE-autostart-after=panel',
    '',
  ].join('\n');
  fs.writeFileSync(p, body, { encoding: 'utf8', mode: 0o644 });
  return p;
}

function removeAutostart() {
  const p = autostartPath();
  try {
    fs.unlinkSync(p);
    return true;
  } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw e;
  }
}

module.exports = {
  APP_DIR_NAME,
  paths,
  defaultConfig,
  normalizeServerUrl,
  normalizeMachineId,
  normalizeConfig,
  loadConfig,
  saveConfig,
  maskKey,
  defaultMachineId,
  privacyFlagEnabled,
  setPrivacyFlag,
  autostartPath,
  writeAutostart,
  removeAutostart,
  quoteDesktopExecArg,
};
