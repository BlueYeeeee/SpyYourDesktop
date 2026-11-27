#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');

const configLib = require('./lib/config');
const { Logger } = require('./lib/logger');
const { detectSession, describeSession, Detector } = require('./lib/providers');
const {
  VERSION,
  upload,
  parseRetryAfterMs,
  serverErrorSummary,
  UploadTransportError,
} = require('./lib/uploader');
const { sanitizeText, readFileSafe } = require('./lib/util');

const APP_NAME = 'SpyYourDesktop';
const PRIVACY_TITLE = 'TA现在不想给你看QAQ';
const PRIVACY_APP = 'private mode';

function printHelp() {
  const lines = [
    APP_NAME + ' Linux 客户端 v' + VERSION,
    '',
    '用法：',
    '  spy-your-desktop init                 交互式写入配置',
    '  spy-your-desktop run                  前台运行（Ctrl+C 停止）',
    '  spy-your-desktop start                后台运行',
    '  spy-your-desktop stop                 停止后台运行',
    '  spy-your-desktop restart              重启后台运行',
    '  spy-your-desktop status               查看运行状态',
    '  spy-your-desktop test                 采集并上传一次，验证连接',
    '  spy-your-desktop show                 显示当前配置',
    '  spy-your-desktop privacy on|off|status 隐私模式（仅上报占位内容）',
    '  spy-your-desktop autostart install|remove|status 登录自启动',
    '  spy-your-desktop version              显示版本',
    '',
    'init 可用非交互参数：',
    '  --server URL --machine ID --key KEY --interval 5 --heartbeat 10',
    '  --max-title-len 150 --force',
    '',
    '其他可用参数：',
    '  --config FILE    指定配置文件',
    '  --privacy        本次运行启用隐私模式',
    '  --log-level debug|info|warn|error',
    '  --no-log-file    不写日志文件',
    '',
    '配置默认路径：' + configLib.paths().configPath,
    '日志默认路径：' + configLib.paths().logPath,
    '',
    '安全说明：本客户端只上传当前窗口标题和应用名，不上传截图、键盘输入、',
    '剪贴板或文件内容；可随时停止或开启隐私模式。',
  ];
  console.log(lines.join('\n'));
}

function parseFlags(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      positional.push.apply(positional, argv.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      let key;
      let value;
      if (eq >= 0) {
        key = arg.slice(2, eq);
        value = arg.slice(eq + 1);
      } else {
        key = arg.slice(2);
        const next = argv[i + 1];
        if (next != null && !next.startsWith('-')) {
          value = next;
          i++;
        } else {
          value = true;
        }
      }
      flags[key] = value;
    } else if (arg.startsWith('-') && arg.length > 1) {
      flags[arg.slice(1)] = true;
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

function flagBool(flags, name) {
  const v = flags[name];
  return v === true || v === 'true' || v === '1' || v === 'yes';
}

function envBool(name) {
  const v = process.env[name];
  return v === '1' || v === 'true' || v === 'yes';
}

function applyGlobalFlags(flags) {
  if (flags.config) process.env.SPY_CONFIG_FILE = path.resolve(String(flags.config));
  if (flags['state-dir']) process.env.SPY_STATE_DIR = path.resolve(String(flags['state-dir']));
  if (flags['config-dir']) process.env.SPY_CONFIG_DIR = path.resolve(String(flags['config-dir']));
}

function makeLogger(flags, options) {
  const opts = options || {};
  return new Logger({
    level: flags['log-level'] || process.env.SPY_LOG_LEVEL || 'info',
    logPath: flagBool(flags, 'no-log-file') || opts.noFile ? null : configLib.paths().logPath,
  });
}

function loadConfigOrThrow(flags) {
  return configLib.loadConfig({ configPath: process.env.SPY_CONFIG_FILE || undefined });
}

function isProcessAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function readPid() {
  const p = configLib.paths().pidPath;
  const text = readFileSafe(p);
  if (!text) return null;
  const pid = parseInt(text.trim(), 10);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

function removePidFileIfOurs(pid) {
  const p = configLib.paths().pidPath;
  try {
    const text = readFileSafe(p);
    if (text && parseInt(text.trim(), 10) === pid) fs.unlinkSync(p);
  } catch (_) {
    // ignore
  }
}

function acquirePidLock() {
  const p = configLib.paths().pidPath;
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(p, 'wx', 0o644);
      fs.writeSync(fd, String(process.pid) + '\n');
      fs.closeSync(fd);
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const oldPid = readPid();
      if (oldPid && isProcessAlive(oldPid)) {
        throw new Error('客户端已在运行（pid ' + oldPid + '）。请先运行：spy-your-desktop stop');
      }
      try {
        fs.unlinkSync(p);
      } catch (_) {
        // ignore
      }
    }
  }
  throw new Error('无法创建 pid 文件：' + p);
}

function selfExecLine(args) {
  const parts = [];
  if (process.pkg) {
    parts.push(configLib.quoteDesktopExecArg(process.execPath));
  } else {
    parts.push(configLib.quoteDesktopExecArg(process.execPath));
    if (process.argv[1]) parts.push(configLib.quoteDesktopExecArg(path.resolve(process.argv[1])));
  }
  for (const a of args) parts.push(configLib.quoteDesktopExecArg(a));
  return parts.join(' ');
}

async function ask(rl, question, defaultValue) {
  const suffix = defaultValue ? ' [' + defaultValue + ']' : '';
  return new Promise((resolve) => {
    rl.question(question + suffix + '：', (answer) => {
      const text = String(answer || '').trim();
      resolve(text || defaultValue || '');
    });
  });
}

async function confirm(rl, question, defaultYes) {
  const a = await ask(rl, question + (defaultYes ? ' [Y/n]' : ' [y/N]'), defaultYes ? 'y' : 'n');
  return /^y(es)?$/i.test(a);
}

async function initCommand(flags) {
  const p = configLib.paths();
  const existing = configLib.loadConfig({ required: false, configPath: p.configPath });
  const nonInteractive =
    flags.server != null ||
    flags.machine != null ||
    flags.key != null ||
    !process.stdin.isTTY;

  if (existing && !flagBool(flags, 'force') && !nonInteractive) {
    console.log('已存在配置文件：' + p.configPath);
    console.log('  服务器：' + existing.serverUrl);
    console.log('  设备 ID：' + existing.machineId);
    const rl0 = readline.createInterface({ input: process.stdin, output: process.stdout });
    const overwrite = await confirm(rl0, '要覆盖它吗？', false);
    rl0.close();
    if (!overwrite) {
      console.log('已取消。');
      return 0;
    }
  }

  let data;
  if (nonInteractive) {
    const merged = Object.assign({}, existing || configLib.defaultConfig(), {
      serverUrl:
        flags.server != null
          ? String(flags.server)
          : existing
            ? existing.serverUrl
            : configLib.defaultConfig().serverUrl,
      machineId:
        flags.machine != null
          ? String(flags.machine)
          : existing
            ? existing.machineId
            : configLib.defaultMachineId(),
      uploadKey:
        flags.key != null ? String(flags.key) : existing ? existing.uploadKey : '',
      intervalSec:
        flags.interval != null ? parseInt(flags.interval, 10) : existing ? existing.intervalSec : 5,
      heartbeatSec:
        flags.heartbeat != null
          ? parseInt(flags.heartbeat, 10)
          : existing
            ? existing.heartbeatSec
            : 10,
      maxTitleLen:
        flags['max-title-len'] != null
          ? parseInt(flags['max-title-len'], 10)
          : existing
            ? existing.maxTitleLen
            : 150,
    });
    if (!merged.machineId) {
      throw new Error('非交互模式必须提供 --machine（设备 ID）');
    }
    data = configLib.normalizeConfig(merged);
  } else {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      console.log('=== SpyYourDesktop Linux 配置向导 ===');
      console.log('提示：设备 ID 必须已加入服务端 group-map.json 中对应密钥的名单，否则上传会 403。');
      const defaults = existing || configLib.defaultConfig();
      const server = await ask(rl, '服务器上报地址', defaults.serverUrl || 'http://127.0.0.1:3000/api/ingest');
      const machine = await ask(
        rl,
        '设备 ID（machine-id）',
        defaults.machineId || configLib.defaultMachineId()
      );
      const keyPrompt = defaults.uploadKey
        ? '上传密钥（留空保持不变）'
        : '上传密钥（服务端 name-keys.json 里的 key）';
      const key = await ask(rl, keyPrompt, '');
      const interval = await ask(rl, '监控间隔（秒，最小 5）', String(defaults.intervalSec || 5));
      const heartbeat = await ask(
        rl,
        '强制心跳（秒，最小 10）',
        String(defaults.heartbeatSec || 10)
      );
      data = configLib.normalizeConfig({
        serverUrl: server,
        machineId: machine,
        uploadKey: key || defaults.uploadKey || '',
        intervalSec: parseInt(interval, 10),
        heartbeatSec: parseInt(heartbeat, 10),
        maxTitleLen: defaults.maxTitleLen || 150,
      });
    } finally {
      rl.close();
    }
  }

  if (!data.machineId) throw new Error('设备 ID 不能为空');
  const saved = configLib.saveConfig(data, p.configPath);
  console.log('');
  console.log('配置已保存：' + p.configPath);
  console.log('  服务器：' + saved.serverUrl);
  console.log('  设备 ID：' + saved.machineId);
  console.log('  上传密钥：' + configLib.maskKey(saved.uploadKey));
  console.log('  间隔：' + saved.intervalSec + ' 秒，心跳：' + saved.heartbeatSec + ' 秒');
  console.log('  日志：' + p.logPath);
  console.log('');
  console.log('下一步：spy-your-desktop test  （验证能否上传）');
  console.log('然后：  spy-your-desktop start （后台运行）');

  if (!nonInteractive) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const runTest = await confirm(rl, '现在发送一条测试数据吗？', true);
    rl.close();
    if (runTest) return testCommand(flags);
  }
  return 0;
}

async function showCommand() {
  const p = configLib.paths();
  const cfg = loadConfigOrThrow({});
  console.log('配置文件：' + p.configPath);
  console.log('服务器：' + cfg.serverUrl);
  console.log('设备 ID：' + cfg.machineId);
  console.log('上传密钥：' + configLib.maskKey(cfg.uploadKey));
  console.log('监控间隔：' + cfg.intervalSec + ' 秒');
  console.log('强制心跳：' + cfg.heartbeatSec + ' 秒');
  console.log('标题上限：' + cfg.maxTitleLen);
  console.log('隐私模式：' + (configLib.privacyFlagEnabled() ? 'on（仅上报占位内容）' : 'off'));
  console.log('日志：' + p.logPath);
  const pid = readPid();
  console.log('运行状态：' + (pid && isProcessAlive(pid) ? '运行中（pid ' + pid + '）' : '未运行'));
  const session = detectSession();
  console.log('会话环境：' + describeSession(session));
  return 0;
}

function makeWindowInfo(info, source, session) {
  const base = info || {
    title: '',
    app: '',
    pid: 0,
    noWindow: true,
  };
  return {
    title: sanitizeText(base.title, 4096),
    app: sanitizeText(base.app, 512),
    pid: Number(base.pid) || 0,
    noWindow: !!base.noWindow,
    source: source || base.source || 'unknown',
    session: session.type,
    desktop: session.desktop,
  };
}

async function testCommand(flags) {
  const cfg = loadConfigOrThrow(flags);
  const session = detectSession();
  const privacy = flagBool(flags, 'privacy') || envBool('SPY_PRIVACY') || configLib.privacyFlagEnabled();
  const log = makeLogger(flags, { noFile: false });

  log.info(APP_NAME + ' Linux v' + VERSION + ' 测试上传');
  log.info('服务器：' + cfg.serverUrl);
  log.info('设备：' + cfg.machineId);
  log.info('会话：' + describeSession(session));

  const detector = new Detector({ log, session, paths: configLib.paths() });
  let info;
  try {
    if (privacy) {
      info = {
        title: PRIVACY_TITLE,
        app: PRIVACY_APP,
        pid: 0,
        source: 'privacy',
      };
      log.info('隐私模式已开启：只会上传占位内容');
    } else {
      await detector.start();
      info = await detector.getActiveWindow();
    }
  } catch (e) {
    log.error('无法获取活动窗口：' + e.message);
    await detector.stop().catch(() => {});
    return 1;
  }
  await detector.stop().catch(() => {});

  const windowInfo = makeWindowInfo(info, info && info.source, session);
  if (windowInfo.noWindow) {
    log.warn('没有检测到活动窗口，将上传空标题（用于心跳/在线状态）');
  } else {
    log.info('检测到：' + windowInfo.app + ' - ' + windowInfo.title);
  }

  let response;
  try {
    response = await upload(cfg, windowInfo, 'test');
  } catch (e) {
    log.error(e.message);
    return 1;
  }

  if (response.status === 426 && response.json && response.json.error === 'update_notice') {
    log.warn('服务器首次上报提示：' + serverErrorSummary(response));
    log.warn('这是服务端的一次性更新提示，客户端会继续；稍后重试一次...');
    await new Promise((r) => setTimeout(r, 1200));
    try {
      response = await upload(cfg, windowInfo, 'test');
    } catch (e) {
      log.error(e.message);
      return 1;
    }
  } else if (response.status === 429) {
    const wait = Math.min(parseRetryAfterMs(response) + 250, 30000);
    log.warn('服务器限速（429），' + wait + 'ms 后重试一次...');
    await new Promise((r) => setTimeout(r, wait));
    try {
      response = await upload(cfg, windowInfo, 'test');
    } catch (e) {
      log.error(e.message);
      return 1;
    }
  }

  if (response.status === 200) {
    log.info('上传成功：HTTP 200 ' + (response.text || '').trim());
    return 0;
  }

  log.error('上传失败：HTTP ' + response.status + ' ' + serverErrorSummary(response));
  if (response.status === 401) {
    log.error('请检查上传密钥是否与 name-keys.json 一致。');
  } else if (response.status === 403) {
    log.error('请检查设备 ID 是否已加入 group-map.json 中对应名字的名单。');
  } else if (response.status === 400) {
    log.error('请检查服务器返回内容；标题长度上限可通过 --max-title-len 调整。');
  }
  return 1;
}

function interruptibleSleep(ms) {
  let wake = null;
  const promise = new Promise((resolve) => {
    const timer = setTimeout(() => {
      wake = null;
      resolve();
    }, ms);
    wake = () => {
      clearTimeout(timer);
      wake = null;
      resolve();
    };
  });
  return { promise, wake: () => (wake ? wake() : null) };
}

async function runCommand(flags) {
  const cfg = loadConfigOrThrow(flags);
  const log = makeLogger(flags);
  const session = detectSession();
  const pid = process.pid;

  if (process.getuid && process.getuid() === 0) {
    log.warn('正在以 root 运行。建议使用普通用户运行，否则 D-Bus/桌面会话可能不可用。');
  }

  acquirePidLock();
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    removePidFileIfOurs(pid);
  };
  process.on('exit', cleanup);

  let stopping = false;
  let exitCode = 0;
  let sleepHandle = null;
  const forcedPrivacy = flagBool(flags, 'privacy') || envBool('SPY_PRIVACY');
  let filePrivacy = configLib.privacyFlagEnabled();
  let privacy = forcedPrivacy || filePrivacy;
  let cfgCurrent = cfg;

  const requestStop = (signal) => {
    if (stopping) {
      log.warn('再次收到 ' + signal + '，强制退出');
      try {
        removePidFileIfOurs(pid);
      } catch (_) {
        // ignore
      }
      process.exit(signal === 'SIGINT' ? 130 : 143);
    }
    stopping = true;
    log.info('收到 ' + signal + '，正在停止...');
    if (sleepHandle) sleepHandle.wake();
  };
  process.on('SIGINT', () => requestStop('SIGINT'));
  process.on('SIGTERM', () => requestStop('SIGTERM'));
  process.on('SIGHUP', () => {
    try {
      cfgCurrent = loadConfigOrThrow(flags);
      log.info('已重新加载配置：' + cfgCurrent.serverUrl + '，间隔 ' + cfgCurrent.intervalSec + 's');
    } catch (e) {
      log.warn('重新加载配置失败，继续使用旧配置：' + e.message);
    }
  });

  log.info(APP_NAME + ' Linux v' + VERSION);
  log.info('配置文件：' + configLib.paths().configPath);
  log.info('服务器：' + cfgCurrent.serverUrl);
  log.info('设备 ID：' + cfgCurrent.machineId);
  log.info('会话：' + describeSession(session));
  log.info(
    '间隔：' + cfgCurrent.intervalSec + 's，心跳：' + cfgCurrent.heartbeatSec + 's' +
      '，隐私模式：' + (privacy ? 'on' : 'off')
  );
  log.info('日志：' + configLib.paths().logPath);
  log.info('开始监控，按 Ctrl+C 停止（或运行 spy-your-desktop stop）');

  const detector = new Detector({ log, session, paths: configLib.paths() });
  try {
    await detector.start();
  } catch (e) {
    log.error(e.message);
    await detector.stop().catch(() => {});
    cleanup();
    return 1;
  }

  let lastTitle = null;
  let lastApp = null;
  let lastSentAt = 0;
  let lastNoticeLog = 0;
  let lastOutdatedLog = 0;
  let lastNetLog = 0;
  const noticeLogInterval = 60 * 1000;
  const netLogInterval = 30 * 1000;

  const fatal = (message) => {
    const e = new Error(message);
    e.fatal = true;
    return e;
  };

  while (!stopping) {
    let delayMs = cfgCurrent.intervalSec * 1000;
    try {
      const flagNow = configLib.privacyFlagEnabled();
      if (flagNow !== filePrivacy) {
        filePrivacy = flagNow;
        privacy = forcedPrivacy || filePrivacy;
        lastTitle = null;
        lastApp = null;
        lastSentAt = 0;
        log.info('隐私模式已' + (privacy ? '开启（只上报占位内容）' : '关闭（恢复采集窗口标题）'));
      }

      let info = null;
      if (privacy) {
        info = {
          title: PRIVACY_TITLE,
          app: PRIVACY_APP,
          pid: 0,
          source: 'privacy',
        };
      } else {
        try {
          info = await detector.getActiveWindow();
        } catch (e) {
          log.warn('无法读取活动窗口：' + e.message);
        }
        if (!info) {
          info = {
            title: '',
            app: '',
            pid: 0,
            noWindow: true,
            source: detector.providerLabel || 'unknown',
          };
        }
      }

      const windowInfo = makeWindowInfo(info, info.source, session);
      windowInfo.title = sanitizeText(windowInfo.title, cfgCurrent.maxTitleLen);
      windowInfo.app = sanitizeText(windowInfo.app, 512);

      const changed =
        windowInfo.title !== lastTitle || windowInfo.app !== lastApp;
      const dueHeartbeat =
        Date.now() - lastSentAt >= cfgCurrent.heartbeatSec * 1000;

      if (changed || dueHeartbeat) {
        const reason = changed ? 'change' : 'heartbeat';
        try {
          const response = await upload(cfgCurrent, windowInfo, reason);
          if (response.status === 200) {
            lastTitle = windowInfo.title;
            lastApp = windowInfo.app;
            lastSentAt = Date.now();
            log.info(
              '[sent ' + reason + '] ' +
                new Date().toLocaleString('zh-CN', { hour12: false }) +
                ' | ' + (windowInfo.app || '-') + ' - ' + (windowInfo.title || '-')
            );
          } else if (
            response.status === 426 &&
            response.json &&
            response.json.error === 'update_notice'
          ) {
            const now = Date.now();
            if (now - lastNoticeLog > noticeLogInterval) {
              lastNoticeLog = now;
              log.warn(
                '服务器返回一次性更新提示（426 update_notice），这是正常现象，下一轮会继续上报。'
              );
            }
          } else if (response.status === 429) {
            const wait = Math.min(parseRetryAfterMs(response) + 250, 60000);
            log.warn('服务器限速（429），' + wait + 'ms 后再试');
            delayMs = Math.max(delayMs, wait);
          } else if (response.status === 426) {
            const now = Date.now();
            if (now - lastOutdatedLog > 10 * 60 * 1000) {
              lastOutdatedLog = now;
              log.warn(
                '服务器认为客户端版本不满足要求（426）：' + serverErrorSummary(response)
              );
            }
          } else if (
            response.status === 400 ||
            response.status === 401 ||
            response.status === 403
          ) {
            throw fatal(
              '服务器拒绝上报（HTTP ' +
                response.status +
                '）：' +
                serverErrorSummary(response)
            );
          } else {
            const now = Date.now();
            if (now - lastNetLog > netLogInterval) {
              lastNetLog = now;
              log.warn(
                '上报失败（HTTP ' + response.status + '）：' + serverErrorSummary(response)
              );
            }
          }
        } catch (e) {
          if (e.fatal) throw e;
          const now = Date.now();
          if (now - lastNetLog > netLogInterval) {
            lastNetLog = now;
            log.warn(
              '上报失败：' + (e instanceof UploadTransportError ? e.message : e.message)
            );
          }
        }
      } else {
        log.debug('窗口未变化，跳过本轮上报');
      }
    } catch (e) {
      log.error(e.message);
      if (e.fatal) {
        exitCode = 1;
        break;
      }
    }

    if (!stopping) {
      sleepHandle = interruptibleSleep(delayMs);
      await sleepHandle.promise;
      sleepHandle = null;
    }
  }

  log.info('正在关闭活动窗口来源...');
  try {
    await detector.stop();
  } catch (e) {
    log.debug('关闭窗口来源失败：' + e.message);
  }
  cleanup();
  log.info('已停止。');
  return exitCode;
}

async function startCommand(flags) {
  const cfg = loadConfigOrThrow(flags);
  const existingPid = readPid();
  if (existingPid && isProcessAlive(existingPid)) {
    console.log('客户端已在运行（pid ' + existingPid + '）。');
    return 0;
  }

  const paths = configLib.paths();
  fs.mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });

  const childEnv = Object.assign({}, process.env);
  if (flagBool(flags, 'privacy')) childEnv.SPY_PRIVACY = '1';
  else delete childEnv.SPY_PRIVACY;
  if (flags['log-level']) childEnv.SPY_LOG_LEVEL = String(flags['log-level']);
  else delete childEnv.SPY_LOG_LEVEL;

  let args;
  if (process.pkg) {
    // pkg injects PKG_EXECPATH into spawned children and interprets the first
    // argument as a module path. Spawn without arguments: "run" is the default
    // when a config exists. Extra options are passed through environment vars.
    args = [];
    childEnv.SPY_BACKGROUND = '1';
  } else {
    args = ['run'];
    if (flagBool(flags, 'privacy')) args.push('--privacy');
    if (flags['log-level']) args.push('--log-level', String(flags['log-level']));
    if (process.env.SPY_CONFIG_FILE) args.push('--config', process.env.SPY_CONFIG_FILE);
  }

  const spawnLogPath = path.join(paths.stateDir, 'spawn.log');
  let spawnFd = null;
  try {
    spawnFd = fs.openSync(spawnLogPath, 'a', 0o600);
  } catch (_) {
    // diagnostics are optional
  }

  let spawnError = null;
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: spawnFd == null ? 'ignore' : ['ignore', spawnFd, spawnFd],
    cwd: process.cwd(),
    env: childEnv,
  });
  child.on('error', (e) => {
    spawnError = e;
  });
  child.unref();
  if (spawnFd != null) {
    try {
      fs.closeSync(spawnFd);
    } catch (_) {
      // ignore
    }
  }

  const deadline = Date.now() + 3000;
  let startedPid = null;
  while (Date.now() < deadline) {
    const p = readPid();
    if (p && isProcessAlive(p)) {
      startedPid = p;
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  if (startedPid) {
    console.log('已在后台启动（pid ' + startedPid + '）。');
    console.log('设备 ID：' + cfg.machineId);
    console.log('日志：' + paths.logPath);
    console.log('停止：spy-your-desktop stop');
    return 0;
  }

  console.error('启动失败或超时。请查看日志：' + paths.logPath);
  if (spawnError) console.error('启动错误：' + spawnError.message);
  const spawnText = readFileSafe(spawnLogPath);
  if (spawnText && spawnText.trim()) {
    console.error('--- spawn.log ---');
    console.error(spawnText.trim().split(/\r?\n/).slice(-12).join('\n'));
  }
  const logText = readFileSafe(paths.logPath);
  if (logText) {
    const lines = logText.trim().split(/\r?\n/).slice(-12);
    console.error(lines.join('\n'));
  }
  return 1;
}

async function stopCommand() {
  const pid = readPid();
  if (!pid) {
    console.log('客户端未运行。');
    return 0;
  }
  if (!isProcessAlive(pid)) {
    removePidFileIfOurs(pid);
    console.log('客户端未运行（已清理过期 pid 文件）。');
    return 0;
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch (e) {
    console.error('发送停止信号失败：' + e.message);
    return 1;
  }
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      removePidFileIfOurs(pid);
      console.log('已停止（pid ' + pid + '）。');
      return 0;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  try {
    process.kill(pid, 'SIGKILL');
    removePidFileIfOurs(pid);
    console.log('进程未在 5 秒内退出，已强制结束（pid ' + pid + '）。');
  } catch (e) {
    console.error('停止失败：' + e.message);
    return 1;
  }
  return 0;
}

async function restartCommand(flags) {
  await stopCommand();
  return startCommand(flags);
}

function statusCommand() {
  const pid = readPid();
  const running = pid && isProcessAlive(pid);
  let cfg = null;
  try {
    cfg = loadConfigOrThrow({});
  } catch (_) {
    // status should still work without a config
  }
  console.log(APP_NAME + ' Linux v' + VERSION);
  console.log('运行状态：' + (running ? '运行中（pid ' + pid + '）' : '未运行'));
  if (cfg) {
    console.log('服务器：' + cfg.serverUrl);
    console.log('设备 ID：' + cfg.machineId);
    console.log('间隔/心跳：' + cfg.intervalSec + 's / ' + cfg.heartbeatSec + 's');
    console.log('隐私模式：' + (configLib.privacyFlagEnabled() ? 'on' : 'off'));
  } else {
    console.log('配置：未找到（请运行 spy-your-desktop init）');
  }
  console.log('日志：' + configLib.paths().logPath);
  return 0;
}

function privacyCommand(positional, flags) {
  const action = (positional[0] || 'status').toLowerCase();
  if (action === 'on') {
    configLib.setPrivacyFlag(true);
    console.log('隐私模式已开启：仅上报占位内容，不采集标题/应用名。');
    console.log('正在运行的客户端会在下一轮自动生效。');
    return 0;
  }
  if (action === 'off') {
    configLib.setPrivacyFlag(false);
    console.log('隐私模式已关闭：恢复采集窗口标题和应用名。');
    return 0;
  }
  if (action === 'status' || action === 'show') {
    console.log('隐私模式：' + (configLib.privacyFlagEnabled() ? 'on' : 'off'));
    return 0;
  }
  console.error('用法：spy-your-desktop privacy on|off|status');
  return 1;
}

function autostartCommand(positional) {
  const action = (positional[0] || 'status').toLowerCase();
  const p = configLib.autostartPath();
  if (action === 'install') {
    const execArgs = ['start'];
    if (process.env.SPY_CONFIG_FILE) {
      execArgs.push('--config', process.env.SPY_CONFIG_FILE);
    }
    const exec = selfExecLine(execArgs);
    const written = configLib.writeAutostart(exec);
    console.log('已安装登录自启动：' + written);
    console.log('Exec=' + exec);
    console.log('下次登录桌面时会自动后台运行；现在可运行 spy-your-desktop start。');
    return 0;
  }
  if (action === 'remove' || action === 'uninstall') {
    const removed = configLib.removeAutostart();
    console.log(removed ? '已移除登录自启动。' : '未安装登录自启动。');
    return 0;
  }
  if (action === 'status') {
    const exists = fs.existsSync(p);
    console.log('登录自启动：' + (exists ? '已安装（' + p + '）' : '未安装'));
    if (exists) {
      const text = readFileSafe(p);
      const line = text && text.split(/\r?\n/).find((l) => l.startsWith('Exec='));
      if (line) console.log(line);
    }
    return 0;
  }
  console.error('用法：spy-your-desktop autostart install|remove|status');
  return 1;
}

async function main() {
  const argv = process.argv.slice(2);
  const parsed = parseFlags(argv);
  applyGlobalFlags(parsed.flags);

  let command = parsed.positional[0];
  let positional = parsed.positional.slice(1);

  if (parsed.flags.help || command === 'help' || command === '-h') {
    printHelp();
    return 0;
  }
  if (parsed.flags.version || command === 'version' || command === '--version') {
    console.log(APP_NAME + ' Linux ' + VERSION);
    return 0;
  }

  if (!command) {
    if (configLib.loadConfig({ required: false })) {
      command = 'run';
    } else {
      printHelp();
      return 0;
    }
  }

  switch (command) {
    case 'init':
      return initCommand(parsed.flags);
    case 'run':
      return runCommand(parsed.flags);
    case 'test':
    case 'once':
      return testCommand(parsed.flags);
    case 'start':
      return startCommand(parsed.flags);
    case 'stop':
      return stopCommand();
    case 'restart':
      return restartCommand(parsed.flags);
    case 'status':
      return statusCommand();
    case 'show':
    case 'config':
      return showCommand();
    case 'privacy':
      return privacyCommand(positional, parsed.flags);
    case 'autostart':
      return autostartCommand(positional);
    default:
      console.error('未知命令：' + command);
      printHelp();
      return 1;
  }
}

main()
  .then((code) => {
    process.exitCode = code || 0;
  })
  .catch((e) => {
    console.error('错误：' + (e && e.message ? e.message : e));
    if (process.env.SPY_DEBUG === '1' && e && e.stack) console.error(e.stack);
    process.exitCode = 1;
  });
