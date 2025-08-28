// server.js — Node v12 兼容（鉴权 + 白名单 + 限速 + 严格本地版本校验 + 一次性更新提示 + 多源保留）
// -------------------------------------------------------------------
// 环境变量（补充了 MIN_VERSIONS_PATH）：
//   PORT=3000
//   DB_PATH=./data.db
//   PUBLIC_DIR=./public
//   GROUP_MAP_PATH=./public/group-map.json
//   NAME_KEYS_PATH=./public/name-keys.json
//   CORS_ORIGIN=*
//
//   MIN_VERSIONS_PATH=./public/min-versions.json    // 新增，本地最低版本配置
//
//   CLEAN_MODE=keep-one|wipe
//   CLEAR_HOUR=3
//   CLEAR_MINUTE=5
//
//   MAX_TITLE_LEN=150
//   MIN_INGEST_INTERVAL_MS=4000
//
//   // 一次性更新提示（本次进程生命周期内首次上报触发一次）
//   ONE_TIME_UPDATE_PROMPT_ENABLED=1
//   FIRST_PROMPT_DIR=./first-prompt
//
//   // 版本校验（保留开关）
//   APP_UPDATE_CHECK_ENABLED=1
//   DEBUG_UPDATE_CHECK=0
// -------------------------------------------------------------------

require('dotenv').config();
const express = require('express');
const path = require('path');
const morgan = require('morgan');
const cors = require('cors');
const fs = require('fs');
const https = require('https');
const dns = require('dns');
const url = require('url');
const Database = require('better-sqlite3');

// ==== env ====
const PORT = Number(process.env.PORT || 3000);
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data.db');
const PUBLIC_DIR = process.env.PUBLIC_DIR || path.join(__dirname, 'public');
const GROUP_MAP_PATH = process.env.GROUP_MAP_PATH || path.join(PUBLIC_DIR, 'group-map.json');
const NAME_KEYS_PATH = process.env.NAME_KEYS_PATH || path.join(PUBLIC_DIR, 'name-keys.json');
const CORS_ORIGIN = process.env.CORS_ORIGIN || '';
const MAX_TITLE_LEN = Number(process.env.MAX_TITLE_LEN || 150);

const CLEAN_MODE = String(process.env.CLEAN_MODE || 'keep-one').toLowerCase();
const CLEAR_HOUR = Number(process.env.CLEAR_HOUR || 3);
const CLEAR_MINUTE = Number(process.env.CLEAR_MINUTE || 5);

const MIN_INGEST_INTERVAL_MS = Number(process.env.MIN_INGEST_INTERVAL_MS || 4000);

// 一次性更新提示配置
const ONE_TIME_UPDATE_PROMPT_ENABLED = (process.env.ONE_TIME_UPDATE_PROMPT_ENABLED || '1') === '1';
const FIRST_PROMPT_DIR = process.env.FIRST_PROMPT_DIR || path.join(__dirname, 'first-prompt');

// 版本校验配置（改为使用本地 min-versions.json）
const APP_UPDATE_CHECK_ENABLED = (process.env.APP_UPDATE_CHECK_ENABLED || '1') === '1';
const DEBUG_UPDATE_CHECK = (process.env.DEBUG_UPDATE_CHECK || '0') === '1';
const MIN_VERSIONS_PATH = process.env.MIN_VERSIONS_PATH || path.join(PUBLIC_DIR, 'min-versions.json');

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
const app = express();
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
const db = new Database(DB_PATH);
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

// ==== 5 秒软缓存：group-map & name-keys ====
var __gmCache = null, __gmTS = 0;
var __nkCache = null, __nkTS = 0;

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

// ---- 新增：本地 min-versions.json 读取（5s 缓存） ----
var __mvCache = null, __mvTS = 0;
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
  var hasAnyKey = Object.keys(keys).length > 0;
  if (!hasAnyKey) return next(); // 无配置则放行（便于本地调试）

  var header = req.headers['authorization'] || '';
  var token = header.indexOf('Bearer ') === 0 ? header.slice(7).trim() : '';
  if (!token) return res.status(401).json({ error: 'Unauthorized: missing Bearer token' });

  var name = keys[token];
  if (!name) return res.status(401).json({ error: 'Unauthorized: invalid key' });

  req.__personName = name;
  next();
}

// ===== 版本比较 & 辅助 ——（保留 parseSemver/cmpSemver）
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

// (保留 GitHub / external fetch 代码块，以便未来需要时可恢复，但当前逻辑不会调用它们)
// GitHub API 查询等函数在此略去（保留原来版本的注释/结构），以保持文件可读性。

// 取客户端版本（优先 body）
function pickClientVersion(body, req) {
  return (body && (body.app_version || body.version)) || String(req && req.headers && req.headers['x-app-version'] || '').trim();
}

// —— 客户端 OS 识别（仅根据 body 字段，不依赖 UA） ——
function getClientOS(body) {
  var bodyOs = String((body && (body.os || body.platform)) || '').toLowerCase();
  if (!bodyOs) return null;
  if (bodyOs.indexOf('win') >= 0) return 'windows';
  if (bodyOs.indexOf('android') >= 0) return 'android';
  if (bodyOs.indexOf('ios') >= 0) return 'ios';
  return null;
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

// 上报（鉴权 + 白名单 + 一次性更新提示 + 限速 + 本地严格版本校验）
app.post('/api/ingest', requirePerUserKey, async function(req, res) {
  try {
    var body = req.body || {};
    var machine = body.machine || body.machine_id;
    if (!machine) return res.status(400).json({ error: 'machine-id is required' });

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

    // —— 一次性更新提示（在本次进程启动后，对每台机器首次上报提示一次）——
    if (ONE_TIME_UPDATE_PROMPT_ENABLED) {
      if (!hasPrompted(machine)) {
        // 先落标记，再提示，避免并发重复
        markPrompted(machine);
        var page = 'https://github.com/' + (process.env.APP_GITHUB_REPO || 'BlueYeeeee/SpyYourDesktop') + '/releases';
        return res.status(426).json({
          error: 'If you are using Windows client, a newer Windows client may be available. Please check and update to the latest version.',
          message: 'A newer Windows client may be available. Please check and update to the latest version.',
          release_page: page,
          machine: String(machine)
        });
      }
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
            error: 'Request too frequent, minimum interval is ' + (MIN_INGEST_INTERVAL_MS/1000) + ' seconds',
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

    // —— 严格版本校验（本地 min-versions.json）：仅对 Windows / Android 生效；iOS/其他放行 ——
    if (APP_UPDATE_CHECK_ENABLED) {
      var clientOS = getClientOS(body); // 仅看 body.os 或 body.platform
      if (DEBUG_UPDATE_CHECK) console.log('[update-check] clientOS=', clientOS);

      if (clientOS === 'windows' || clientOS === 'android' || clientOS === 'ios') {
        var currentVer = pickClientVersion(body, req) || '0.0.0';
        if (DEBUG_UPDATE_CHECK) console.log('[update-check] currentVer=', currentVer);

        var minVersions = readMinVersions();
        var required = minVersions[clientOS] || null;

        if (required && cmpSemver(currentVer, required) < 0) {
          return res.status(426).json({
            error: 'outdated_client',
            message: 'Your ' + clientOS + ' app is outdated. Minimum required version is ' + required + ', but you are on ' + currentVer + '. Please update.',
            os: clientOS,
            min_required_version: required,
            current_version: currentVer
          });
        }
      } else {
          return res.status(426).json({
            error: 'outdated_client',
            message: 'Your monitor is outdated. Please update to the latest version.',
            os: clientOS,
            min_required_version: required,
            current_version: currentVer
          });
      }
    }

    // 写库
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
  } catch (e) {
    console.warn('[vacuum] failed:', e.message);
  }
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
  console.log('Update Check (local min-versions):', (APP_UPDATE_CHECK_ENABLED ? 'ON' : 'OFF') + '; MinVersionsPath=' + MIN_VERSIONS_PATH);
});
