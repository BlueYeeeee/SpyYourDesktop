// server.js — Node v12 兼容（鉴权 + 白名单 + 限速 + 一次性更新提示 + 版本校验：本地最低版本 / 多源最新版本 二选一 + 查询 + 清理）
// -------------------------------------------------------------------
// 环境变量：
//   PORT=3000
//   DB_PATH=./data.db
//   PUBLIC_DIR=./public
//   GROUP_MAP_PATH=./public/group-map.json
//   NAME_KEYS_PATH=./public/name-keys.json
//   CORS_ORIGIN=*
//
//   // 提交与长度
//   MAX_TITLE_LEN=150
//   MIN_INGEST_INTERVAL_MS=4000
//
//   // 一次性更新提示（本次进程生命周期内首次上报触发一次）
//   ONE_TIME_UPDATE_PROMPT_ENABLED=1
//   FIRST_PROMPT_DIR=./first-prompt
//
//   // 版本校验（开关 + 策略）
//   APP_UPDATE_CHECK_ENABLED=1
//   UPDATE_STRATEGY=min|latest            // min=本地最低版本；latest=多源最新版本
//   DEBUG_UPDATE_CHECK=0
//
//   // （当 UPDATE_STRATEGY=min 时需要）
//   MIN_VERSIONS_PATH=./public/min-versions.json    // { "windows": "1.2.3", "android": "2.3.4", "ios": "3.4.5" }
//
//   // （当 UPDATE_STRATEGY=latest 时可用）
//   APP_GITHUB_REPO=BlueYeeeee/SpyYourDesktop
//   GITHUB_TOKEN=                          // 可选，提高额度
//   GITHUB_FETCH_TIMEOUT_MS=1500
//   GITHUB_UA=SpyYourDesktop/1.0
//   LATEST_VERSION_OVERRIDE=               // 手动覆盖最新版本（优先级最高）
//   VERSION_SOURCE_URL=                    // 你的自建文本源 URL（内容只是一行版本号）
//   VERSION_SOURCE_TIMEOUT_MS=1200
//
//   // 清理策略
//   CLEAN_MODE=keep-one|wipe
//   CLEAR_HOUR=3
//   CLEAR_MINUTE=5
// -------------------------------------------------------------------

require('dotenv').config();
var express = require('express');
var path = require('path');
var morgan = require('morgan');
var cors = require('cors');
var fs = require('fs');
var https = require('https');
var dns = require('dns');
var url = require('url');
var Database = require('better-sqlite3');

// ==== env ====
var PORT = Number(process.env.PORT || 3000);
var DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data.db');
var PUBLIC_DIR = process.env.PUBLIC_DIR || path.join(__dirname, 'public');
var GROUP_MAP_PATH = process.env.GROUP_MAP_PATH || path.join(PUBLIC_DIR, 'group-map.json');
var NAME_KEYS_PATH = process.env.NAME_KEYS_PATH || path.join(PUBLIC_DIR, 'name-keys.json');
var CORS_ORIGIN = process.env.CORS_ORIGIN || '';
var MAX_TITLE_LEN = Number(process.env.MAX_TITLE_LEN || 150);

var CLEAN_MODE = String(process.env.CLEAN_MODE || 'keep-one').toLowerCase();
var CLEAR_HOUR = Number(process.env.CLEAR_HOUR || 3);
var CLEAR_MINUTE = Number(process.env.CLEAR_MINUTE || 5);

var MIN_INGEST_INTERVAL_MS = Number(process.env.MIN_INGEST_INTERVAL_MS || 4000);

// 一次性更新提示配置
var ONE_TIME_UPDATE_PROMPT_ENABLED = (process.env.ONE_TIME_UPDATE_PROMPT_ENABLED || '1') === '1';
var FIRST_PROMPT_DIR = process.env.FIRST_PROMPT_DIR || path.join(__dirname, 'first-prompt');

// 版本校验配置
var APP_UPDATE_CHECK_ENABLED = (process.env.APP_UPDATE_CHECK_ENABLED || '1') === '1';
var UPDATE_STRATEGY = String(process.env.UPDATE_STRATEGY || 'min').toLowerCase(); // 'min' | 'latest'
var DEBUG_UPDATE_CHECK = (process.env.DEBUG_UPDATE_CHECK || '0') === '1';

// min-strategy 专用
var MIN_VERSIONS_PATH = process.env.MIN_VERSIONS_PATH || path.join(PUBLIC_DIR, 'min-versions.json');

// latest-strategy 专用
var APP_GITHUB_REPO = process.env.APP_GITHUB_REPO || 'BlueYeeeee/SpyYourDesktop';
var GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
var GITHUB_FETCH_TIMEOUT_MS = Number(process.env.GITHUB_FETCH_TIMEOUT_MS || 1500);
var GITHUB_UA = process.env.GITHUB_UA || 'SpyYourDesktop/1.0';
var LATEST_VERSION_OVERRIDE = process.env.LATEST_VERSION_OVERRIDE || '';
var VERSION_SOURCE_URL = process.env.VERSION_SOURCE_URL || '';
var VERSION_SOURCE_TIMEOUT_MS = Number(process.env.VERSION_SOURCE_TIMEOUT_MS || 1200);

function charLen(s) { return String(s).length; }

// ==== helper: ensure first-prompt dir exists ====
function ensureDir(p) {
  try {
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  } catch (e) {
    console.warn('[first-prompt] mkdir failed:', e.message);
  }
}
ensureDir(FIRST_PROMPT_DIR);

// sanitize filename for machine id
function safeFileName(s) {
  return String(s).replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 200);
}
function promptFlagPath(machine) {
  return path.join(FIRST_PROMPT_DIR, safeFileName(machine) + '.flag');
}
function hasPrompted(machine) {
  try { return fs.existsSync(promptFlagPath(machine)); } catch { return false; }
}
function markPrompted(machine) {
  try { fs.writeFileSync(promptFlagPath(machine), String(Date.now()), 'utf8'); } catch (e) { console.warn('[first-prompt] write failed:', e.message); }
}

// ==== app ====
var app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));
app.use(morgan('dev'));
if (CORS_ORIGIN) {
  app.use(cors({
    origin: function (_origin, cb) { cb(null, true); },
    credentials: false,
  }));
}

// ==== db ====
var db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec([
  'CREATE TABLE IF NOT EXISTS events (',
  '  id INTEGER PRIMARY KEY AUTOINCREMENT,',
  '  machine TEXT NOT NULL,',
  '  window_title TEXT,',
  '  app TEXT,',
  '  access_time TEXT NOT NULL,',
  '  raw_json TEXT',
  ');',
  'CREATE INDEX IF NOT EXISTS idx_events_machine_time ON events(machine, access_time DESC);',
  'CREATE INDEX IF NOT EXISTS idx_events_machine_time_id ON events(machine, access_time DESC, id DESC);'
].join('\n'));

// SQLite 版本检测（窗口函数需 >= 3.25.0）
function sqliteVersionAtLeast(target) {
  try {
    var row = db.prepare('select sqlite_version() as v').get();
    var v = (row && row.v) ? row.v : '3.25.0';
    function toNums(s) {
      return String(s).split('.').map(function(n){ var x = parseInt(n,10); return isNaN(x)?0:x; });
    }
    var a = toNums(v), b = toNums(target);
    if (a[0] !== b[0]) return a[0] > b[0];
    if (a[1] !== b[1]) return a[1] > b[1];
    return a[2] >= b[2];
  } catch(e) { return false; }
}
var SUPPORTS_WINDOW_FN = sqliteVersionAtLeast('3.25.0');

// ==== 5 秒软缓存：group-map & name-keys & min-versions ====
var __gmCache = null, __gmTS = 0;
var __nkCache = null, __nkTS = 0;
var __mvCache = null, __mvTS = 0;

function safeReadJSON(candidates) {
  for (var i = 0; i < candidates.length; i++) {
    var p = candidates[i];
    try {
      if (p && fs.existsSync(p)) {
        var txt = fs.readFileSync(p, 'utf8');
        return JSON.parse(txt || '{}');
      }
    } catch (e) {
      console.warn('[readJSON] failed:', p, e.message);
    }
  }
  return {};
}

function readGroupMap() {
  var now = Date.now();
  if (!__gmCache || now - __gmTS > 5000) {
    __gmCache = safeReadJSON([
      GROUP_MAP_PATH,
      path.join(__dirname, 'public', 'group-map.json'),
      path.join(__dirname, 'group-map.json'),
    ]);
    __gmTS = now;
  }
  return __gmCache || {};
}

function readNameKeys() {
  var now = Date.now();
  if (!__nkCache || now - __nkTS > 5000) {
    __nkCache = safeReadJSON([
      NAME_KEYS_PATH,
      path.join(__dirname, 'public', 'name-keys.json'),
      path.join(__dirname, 'name-keys.json'),
    ]);
    __nkTS = now;
  }
  return __nkCache || {};
}

function readMinVersions() {
  var now = Date.now();
  if (!__mvCache || now - __mvTS > 5000) {
    __mvCache = safeReadJSON([
      MIN_VERSIONS_PATH,
      path.join(__dirname, 'public', 'min-versions.json'),
      path.join(__dirname, 'min-versions.json')
    ]);
    __mvTS = now;
  }
  return __mvCache || {};
}

// 倒排：key -> name
function keyToNameMap() {
  var nk = readNameKeys();
  var out = {};
  Object.keys(nk || {}).forEach(function(name) {
    var key = nk[name];
    if (typeof key === 'string' && key.trim()) out[key.trim()] = name;
  });
  return out;
}

function getMachinesByName(name) {
  if (!name) return [];
  var map = readGroupMap();
  if (Object.prototype.hasOwnProperty.call(map, name)) {
    var arr = map[name];
    return Array.isArray(arr) ? arr : [];
  }
  return [];
}

// ==== 鉴权（按人按密钥）====
function requirePerUserKey(req, res, next) {
  var keys = keyToNameMap();
  //var hasAnyKey = Object.keys(keys).length > 0;
  //if (!hasAnyKey) return next(); 无配置则放行（便于本地调试）

  var header = req.headers['authorization'] || '';
  var token = header.indexOf('Bearer ') === 0 ? header.slice(7).trim() : '';
  if (!token) return res.status(401).json({ error: 'Unauthorized: missing Bearer token' });

  var name = keys[token];
  if (!name) return res.status(401).json({ error: 'Unauthorized: invalid key' });

  req.__personName = name;
  next();
}

// ===== 版本比较 & OS/版本识别 =====
function parseSemver(v) {
  if (!v) return [0,0,0];
  var s = String(v).trim().replace(/^v/i, '');
  var parts = s.split('.');
  var major = (parts.length > 0 && parts[0]) ? parts[0] : '0';
  var minor = (parts.length > 1 && parts[1]) ? parts[1] : '0';
  var patch = (parts.length > 2 && parts[2]) ? parts[2] : '0';
  function toInt(x) {
    var n = parseInt(String(x).replace(/\D+/g, '') || '0', 10);
    return isNaN(n) ? 0 : n;
  }
  return [toInt(major), toInt(minor), toInt(patch)];
}
function cmpSemver(a, b) {
  var A = parseSemver(a), B = parseSemver(b);
  for (var i=0;i<3;i++) {
    if (A[i] > B[i]) return 1;
    if (A[i] < B[i]) return -1;
  }
  return 0;
}

// 仅依赖 body 的 OS 识别（min 策略更严格可控）
function getClientOSFromBody(body) {
  var bodyOs = String((body && (body.os || body.platform)) || '').toLowerCase();
  if (!bodyOs) return null;
  if (bodyOs.indexOf('win') >= 0) return 'windows';
  if (bodyOs.indexOf('android') >= 0) return 'android';
  if (bodyOs.indexOf('ios') >= 0) return 'ios';
  return null;
}

// UA 辅助（latest 策略里用来决定是否需要检查）
function isWindowsClient(req) {
  var ua = String(req.headers['user-agent'] || '').toLowerCase();
  var xos = String(req.headers['x-os'] || '').toLowerCase();
  var likelyWin = ua.indexOf('windows') >= 0 || ua.indexOf('win64') >= 0 || ua.indexOf('wow64') >= 0 || ua.indexOf('trident/') >= 0 || ua.indexOf('edge/') >= 0 || ua.indexOf('edg/') >= 0 || ua.indexOf('msie') >= 0;
  var xosWin = xos.indexOf('win') >= 0;
  return likelyWin || xosWin;
}
function pickClientVersion(body, req) {
  return (body && (body.app_version || body.version)) || String(req && req.headers && req.headers['x-app-version'] || '').trim();
}
function shouldCheckVersion(req, body) {
  var uaWin = isWindowsClient(req);
  var currentVer = pickClientVersion(body, req);
  var hasVer = !!currentVer;
  var bodyOs = String((body && (body.os || body.platform)) || '').toLowerCase();
  var bodyWin = bodyOs.indexOf('win') >= 0;
  return uaWin || hasVer || bodyWin; // 任一成立即可触发
}

// ====== latest 策略：多源“最新版本”获取 ======
var __latestVerCache = null, __latestVerTS = 0, __latestVerUrl = null;
function fetchLatestVersionFromGitHub() {
  return new Promise(function(resolve, reject) {
    var now = Date.now();
    if (__latestVerCache && now - __latestVerTS < 60000) {
      return resolve({ version: __latestVerCache, pageUrl: __latestVerUrl });
    }
    if (!APP_GITHUB_REPO) return reject(new Error('APP_GITHUB_REPO not configured'));

    var options = {
      hostname: 'api.github.com',
      path: '/repos/' + APP_GITHUB_REPO + '/releases/latest',
      method: 'GET',
      headers: {
        'User-Agent': GITHUB_UA || 'SpyYourDesktop/1.0',
        'Accept': 'application/vnd.github+json'
      },
      lookup: function(host, opts, cb) { dns.lookup(host, { family: 4 }, cb); },
      agent: new https.Agent({ keepAlive: true, servername: 'api.github.com' })
    };
    if (GITHUB_TOKEN) options.headers.Authorization = 'Bearer ' + GITHUB_TOKEN;

    var req = https.request(options, function(resp) {
      var data = '';
      resp.on('data', function(chunk) { data += chunk; });
      resp.on('end', function() {
        try {
          if (resp.statusCode >= 200 && resp.statusCode < 300) {
            var json = JSON.parse(data || '{}');
            var tag = ((json && json.tag_name) ? json.tag_name : (json && json.name) ? json.name : '').trim();
            var latest = tag || '';
            var pageUrl = (json && json.html_url) ? String(json.html_url) : 'https://github.com/' + APP_GITHUB_REPO + '/releases';
            if (!latest) return reject(new Error('Latest version tag not found'));
            __latestVerCache = latest;
            __latestVerTS = Date.now();
            __latestVerUrl = pageUrl;
            return resolve({ version: latest, pageUrl: pageUrl });
          } else {
            return reject(new Error('GitHub HTTP ' + resp.statusCode + ': ' + data));
          }
        } catch(e) { return reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(GITHUB_FETCH_TIMEOUT_MS, function(){ req.destroy(new Error('GitHub request timeout after ' + GITHUB_FETCH_TIMEOUT_MS + 'ms')); });
    req.end();
  });
}

function fetchText(u, timeoutMs) {
  return new Promise(function(resolve, reject) {
    var p = url.parse(u);
    var opt = {
      protocol: p.protocol,
      hostname: p.hostname,
      port: p.port || 443,
      path: p.path || '/',
      method: 'GET',
      headers: { 'User-Agent': GITHUB_UA || 'SpyYourDesktop/1.0' },
      lookup: function(host, opts, cb) { dns.lookup(host, { family: 4 }, cb); },
      agent: new https.Agent({ keepAlive: true, servername: p.hostname })
    };
    var req = https.request(opt, function(resp) {
      var data = '';
      resp.on('data', function (c) { data += c; });
      resp.on('end', function () {
        if (resp.statusCode >= 200 && resp.statusCode < 300) return resolve(data);
        reject(new Error('HTTP ' + resp.statusCode + ' ' + u));
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs || 1200, function(){ req.destroy(new Error('timeout ' + (timeoutMs||1200) + 'ms ' + u)); });
    req.end();
  });
}

var __latestCache = null, __latestCacheAt = 0, __latestPageUrl = null;
function fetchLatestVersionUnified() {
  return new Promise(function(resolve, reject) {
    var now = Date.now();
    if (__latestCache && now - __latestCacheAt < 60000) {
      return resolve({ version: __latestCache, pageUrl: __latestPageUrl || ('https://github.com/' + APP_GITHUB_REPO + '/releases') });
    }

    if (LATEST_VERSION_OVERRIDE && LATEST_VERSION_OVERRIDE.trim()) {
      __latestCache = LATEST_VERSION_OVERRIDE.trim();
      __latestCacheAt = now;
      __latestPageUrl = 'https://github.com/' + APP_GITHUB_REPO + '/releases';
      return resolve({ version: __latestCache, pageUrl: __latestPageUrl });
    }

    if (VERSION_SOURCE_URL && VERSION_SOURCE_URL.trim()) {
      fetchText(VERSION_SOURCE_URL.trim(), VERSION_SOURCE_TIMEOUT_MS).then(function(txt){
        var ver = String(txt || '').trim();
        if (ver) {
          __latestCache = ver;
          __latestCacheAt = now;
          __latestPageUrl = VERSION_SOURCE_URL.trim();
          return resolve({ version: ver, pageUrl: __latestPageUrl });
        }
        // 如果自建源空则继续 GitHub
        fetchLatestVersionFromGitHub().then(function(gh){
          __latestCache = gh.version; __latestCacheAt = now; __latestPageUrl = gh.pageUrl; resolve(gh);
        }).catch(reject);
      }).catch(function(){
        // 自建源失败则回退 GitHub
        fetchLatestVersionFromGitHub().then(function(gh){
          __latestCache = gh.version; __latestCacheAt = now; __latestPageUrl = gh.pageUrl; resolve(gh);
        }).catch(reject);
      });
      return;
    }

    // 直接 GitHub
    fetchLatestVersionFromGitHub().then(function(gh){
      __latestCache = gh.version; __latestCacheAt = now; __latestPageUrl = gh.pageUrl; resolve(gh);
    }).catch(reject);
  });
}

// ==== API ====

// 健康检查
app.get('/api/health', function(_req, res) { res.json({ ok: true }); });

// 供前端读取 group-map
app.get('/api/group-map', function(_req, res) {
  res.set('Cache-Control', 'no-store');
  res.json(readGroupMap());
});

// 可选：查看有哪些名字（不返回密钥）
app.get('/api/names', function(_req, res) {
  res.json({ names: Object.keys(readGroupMap()) });
});

// 上报（鉴权 + 白名单 + 一次性更新提示 + 限速 + 版本校验）
app.post('/api/ingest', requirePerUserKey, function(req, res) {
  try {
    var body = req.body || {};
    var machine = body.machine || body.machine_id;
    if (!machine) return res.status(400).json({ error: 'machine is required' });

    // 人-机白名单
    var person = req.__personName;
    if (person) {
      var allowList = getMachinesByName(person);
      if (allowList.indexOf(machine) === -1) {
        return res.status(403).json({ error: 'machine not allowed for this key', name: person, machine: machine });
      }
    } else {
      var map = readGroupMap();
      var allAllowed = [];
      Object.keys(map).forEach(function(k){ var arr = map[k]; if (Array.isArray(arr)) allAllowed = allAllowed.concat(arr); });
      if (allAllowed.length && allAllowed.indexOf(machine) === -1) {
        return res.status(403).json({ error: 'machine not allowed (no key mode)', machine: machine });
      }
    }

    // —— 一次性更新提示（进程生命周期内每台机器触发一次）——
    if (ONE_TIME_UPDATE_PROMPT_ENABLED && !hasPrompted(machine)) {
      markPrompted(machine); // 先落标记避免并发重复
      var page = 'https://github.com/' + APP_GITHUB_REPO + '/releases';
      return res.status(426).json({
        error: 'update_notice',
        message: 'A newer Windows client may be available. Please check and update to the latest version.',
        release_page: page,
        machine: String(machine)
      });
    }

    // 标题长度限制
    var title = body.window_title != null ? String(body.window_title) : null;
    if (title && charLen(title) > MAX_TITLE_LEN) {
      return res.status(400).json({ error: 'window_title too long', limit: MAX_TITLE_LEN, length: charLen(title) });
    }

    // 服务器时间
    var t = null;
    if (body.event_time) {
      var dt = new Date(body.event_time);
      if (!isNaN(dt.getTime())) t = dt;
    }
    if (!t) t = new Date();

    // 最小提交间隔限制（按机器）
    try {
      var last = db.prepare('SELECT access_time, id FROM events WHERE machine = ? ORDER BY access_time DESC, id DESC LIMIT 1').get(String(machine));
      var nowMs = t.getTime();
      if (last && last.access_time) {
        var lastMs = new Date(last.access_time).getTime();
        var delta = nowMs - lastMs;
        if (delta < MIN_INGEST_INTERVAL_MS) {
          var retryAfterMs = MIN_INGEST_INTERVAL_MS - delta;
          var retryAfterSec = Math.ceil(retryAfterMs / 1000);
          res.set('Retry-After', String(retryAfterSec));
          return res.status(429).json({
            error: 'too_frequent',
            message: 'Request too frequent, minimum interval is ' + (MIN_INGEST_INTERVAL_MS/1000) + ' seconds',
            machine: String(machine),
            min_interval_ms: MIN_INGEST_INTERVAL_MS,
            elapsed_ms: delta,
            retry_after_ms: retryAfterMs
          });
        }
      }
    } catch(e) {
      console.warn('[rate-limit-check] failed:', e.message);
    }

    // —— 版本校验 ——
    if (APP_UPDATE_CHECK_ENABLED) {
      if (UPDATE_STRATEGY === 'min') {
        // 使用本地最低版本：仅依赖 body.os/body.platform，不看 UA
        var clientOS = getClientOSFromBody(body); // windows | android | ios | null
        if (DEBUG_UPDATE_CHECK) console.log('[update-check:min] os=', clientOS);
        if (clientOS === 'windows' || clientOS === 'android' || clientOS === 'ios') {
          var currentVerMin = pickClientVersion(body, req) || '0.0.0';
          if (DEBUG_UPDATE_CHECK) console.log('[update-check:min] current=', currentVerMin);
          var minVersions = readMinVersions();
          var required = (minVersions && minVersions[clientOS]) ? String(minVersions[clientOS]) : null;
          if (required && cmpSemver(currentVerMin, required) < 0) {
            return res.status(426).json({
              error: 'outdated_client',
              message: 'Your ' + clientOS + ' app is outdated. Minimum required version is ' + required + ', but you are on ' + currentVerMin + '. Please update.',
              os: clientOS,
              min_required_version: required,
              current_version: currentVerMin
            });
          }
        } // 其他 OS 不校验
      } else { // latest
        if (shouldCheckVersion(req, body)) {
          var currentVerLatest = pickClientVersion(body, req);
          if (DEBUG_UPDATE_CHECK) console.log('[update-check:latest] trigger=1 current=', currentVerLatest || '(missing)');
          if (!currentVerLatest) {
            var fallbackReleasesUrl = 'https://github.com/' + APP_GITHUB_REPO + '/releases';
            return res.status(426).json({
              error: 'outdated_client',
              message: 'Your app is outdated or missing version info. Please update to the latest version.',
              latest_version: null,
              current_version: '0.0.0',
              release_page: fallbackReleasesUrl
            });
          }
          // 获取最新版本（覆盖 -> 自建URL -> GitHub）
          fetchLatestVersionUnified().then(function(info){
            var latestVer = info.version;
            var pageUrl = info.pageUrl;
            if (cmpSemver(currentVerLatest, latestVer) < 0) {
              return res.status(426).json({
                error: 'outdated_client',
                message: 'Your app is outdated. Latest version is ' + latestVer + ', but you are on ' + currentVerLatest + '. Please update.',
                latest_version: latestVer,
                current_version: currentVerLatest,
                release_page: pageUrl
              });
            }
            // 未过期则继续写库
            finishInsert();
          }).catch(function(e){
            console.warn('[update-check:latest] failed:', e && e.message);
            // 拉取失败不拦截，继续写库
            finishInsert();
          });
          return; // 注意：latest 分支异步校验，后续由 finishInsert 继续
        } else if (DEBUG_UPDATE_CHECK) {
          console.log('[update-check:latest] trigger=0');
        }
      }
    }

    // 直接写库（min 分支 / 未启用校验 / latest 未触发）
    return finishInsert();

    function finishInsert() {
      try {
        db.prepare('INSERT INTO events (machine, window_title, app, access_time, raw_json) VALUES (@machine,@window_title,@app,@access_time,@raw_json)')
          .run({
            machine: String(machine),
            window_title: body.window_title ? String(body.window_title) : null,
            app: body.app ? String(body.app) : null,
            access_time: t.toISOString(),
            raw_json: body.raw ? JSON.stringify(body.raw) : null,
          });
        return res.json({ ok: true });
      } catch (e) {
        console.error('[ingest/insert] error:', e && e.stack ? e.stack : e);
        return res.status(500).json({ error: 'internal_error' });
      }
    }

  } catch (e) {
    console.error('[ingest] unhandled error:', e && e.stack ? e.stack : e);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// 查询：GET /api/current-status?name=xxx 或 ?machine=xxx
app.get('/api/current-status', function(req, res) {
  try {
    var q = req.query || {};
    var name = q.name;
    var machine = q.machine;
    var limit = Math.min(parseInt(q.limit, 10) || 50, 500);

    var machineList = null;
    if (name) machineList = Array.from(new Set(getMachinesByName(name) || []));
    if (machine) machineList = machineList ? machineList.filter(function(m){ return m === String(machine); }) : [String(machine)];

    var rows = [];
    if (machineList) {
      if (!machineList.length) return res.json([]);
      var placeholders = machineList.map(function(){ return '?'; }).join(',');
      var sql = [
        'SELECT machine, window_title, app, access_time',
        'FROM events',
        'WHERE machine IN (' + placeholders + ')',
        'ORDER BY access_time DESC',
        'LIMIT ?'
      ].join('\n');
      var stmt = db.prepare(sql);
      rows = stmt.all.apply(stmt, machineList.concat([limit]));
    } else {
      rows = db.prepare('SELECT machine, window_title, app, access_time FROM events ORDER BY access_time DESC LIMIT ?').all(limit);
    }
    res.json(rows);
  } catch (e) {
    console.error('[current-status] error:', e && e.stack ? e.stack : e);
    res.status(500).json({ error: 'internal_error' });
  }
});

// 每台机器的最新一条（验证 keep-one 结果）
app.get('/api/current-latest', function(_req, res) {
  try {
    var rows = db.prepare([
      'SELECT e.machine, e.window_title, e.app, e.access_time FROM events e',
      'JOIN (',
      '  SELECT machine, MAX(access_time) AS max_time',
      '  FROM events',
      '  GROUP BY machine',
      ') m ON e.machine = m.machine AND e.access_time = m.max_time',
      'ORDER BY e.machine ASC'
    ].join('\n')).all();
    res.json(rows);
  } catch (e) {
    console.error('[current-latest] error:', e && e.stack ? e.stack : e);
    res.status(500).json({ error: 'internal_error' });
  }
});

// 静态资源
app.use('/', express.static(PUBLIC_DIR));

// 兜底 404
app.use(function(_req, res) {
  res.status(404).json({ error: 'Not found' });
});

// ==== 清理任务 ====
function checkpointAndCompact() {
  try {
    db.prepare('PRAGMA wal_checkpoint(TRUNCATE);').run();
    db.exec('VACUUM;');
  } catch (e) { console.warn('[vacuum] failed:', e.message); }
}
function msUntil(hour, minute) {
  var now = new Date();
  var t = new Date(now);
  t.setHours(hour, minute, 0, 0);
  if (t <= now) t.setDate(t.getDate() + 1);
  return t - now;
}
function scheduleDailyWipe() {
  function wipeOnce() {
    try {
      db.exec('BEGIN');
      var n = db.prepare('DELETE FROM events').run().changes;
      db.exec('COMMIT');
      console.log('[wipe] cleared all events, deleted=' + n);
      checkpointAndCompact();
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch(_e) {}
      console.error('[wipe] failed:', e.message);
    }
  }
  setTimeout(function(){ wipeOnce(); setInterval(wipeOnce, 24*60*60*1000); }, msUntil(CLEAR_HOUR, CLEAR_MINUTE));
}
function scheduleDailyKeepOnePerMachine() {
  var SQL_WINDOW = [
    'WITH ranked AS (',
    '  SELECT id,',
    '         ROW_NUMBER() OVER (PARTITION BY machine ORDER BY access_time DESC, id DESC) AS rn',
    '  FROM events',
    ')',
    'DELETE FROM events',
    'WHERE id IN (SELECT id FROM ranked WHERE rn > 1)'
  ].join('\n');

  var SQL_EXISTS = [
    'DELETE FROM events AS old',
    'WHERE EXISTS (',
    '  SELECT 1 FROM events AS newer',
    '  WHERE newer.machine = old.machine',
    '    AND (newer.access_time > old.access_time',
    '         OR (newer.access_time = old.access_time AND newer.id > old.id))',
    ')'
  ].join('\n');

  function keepOnce() {
    try {
      db.exec('BEGIN');
      db.exec('CREATE INDEX IF NOT EXISTS idx_events_machine_time_id ON events(machine, access_time DESC, id DESC);');
      var sql = SUPPORTS_WINDOW_FN ? SQL_WINDOW : SQL_EXISTS;
      var info = db.prepare(sql).run();
      db.exec('COMMIT');
      console.log('[keep-one] deleted=' + info.changes + ' (engine=' + (SUPPORTS_WINDOW_FN ? 'window-fn' : 'exists') + ')');
      checkpointAndCompact();
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch(_e) {}
      console.error('[keep-one] failed:', e.message);
    }
  }

  setTimeout(function(){ keepOnce(); setInterval(keepOnce, 24*60*60*1000); }, msUntil(CLEAR_HOUR, CLEAR_MINUTE));
}

if (CLEAN_MODE === 'wipe') {
  console.log('[cleanup] mode=wipe at ' + CLEAR_HOUR + ':' + CLEAR_MINUTE);
  scheduleDailyWipe();
} else {
  console.log('[cleanup] mode=keep-one at ' + CLEAR_HOUR + ':' + CLEAR_MINUTE + ' (window-fn=' + (SUPPORTS_WINDOW_FN ? 'true' : 'false') + ')');
  scheduleDailyKeepOnePerMachine();
}

// ==== start ====
app.listen(PORT, function() {
  console.log('Server listening on http://localhost:' + PORT);
  console.log('DB: ' + DB_PATH);
  console.log('Public: ' + PUBLIC_DIR);
  console.log('GroupMap: ' + GROUP_MAP_PATH);
  console.log('NameKeys: ' + NAME_KEYS_PATH);
  console.log('Min Ingest Interval: ' + MIN_INGEST_INTERVAL_MS + ' ms');
  console.log('One-time Update Prompt:', ONE_TIME_UPDATE_PROMPT_ENABLED ? 'ON' : 'OFF', 'Dir=', FIRST_PROMPT_DIR);
  console.log('Update Check:', (APP_UPDATE_CHECK_ENABLED ? 'ON' : 'OFF') + '; Strategy=' + UPDATE_STRATEGY + (UPDATE_STRATEGY==='min' ? ('; MinVersionsPath=' + MIN_VERSIONS_PATH) : ('; Repo=' + (APP_GITHUB_REPO || '(unset)'))));
});
