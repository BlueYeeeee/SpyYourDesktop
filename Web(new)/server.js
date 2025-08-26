// server.js — 按人按密钥鉴权 + 机器白名单 + 每天仅保留每机最新一条（修复 keep-one）
// -------------------------------------------------------------------
// 环境变量：
//   PORT=3000
//   DB_PATH=./data.db
//   PUBLIC_DIR=./public
//   GROUP_MAP_PATH=./public/group-map.json
//   NAME_KEYS_PATH=./public/name-keys.json
//   CORS_ORIGIN=*                  // 非空即启用 CORS（开发方便）
//
//   CLEAN_MODE=keep-one|wipe       // 默认 keep-one：每天每机仅保留“全局最新一条”
//   CLEAR_HOUR=3                   // 每天几点执行
//   CLEAR_MINUTE=5
//
//   MAX_TITLE_LEN=150              // 窗口标题最大允许字符数
//
// 备注：如果找不到 name-keys.json 或其中为空，将回退到“无鉴权（不建议生产）”。
// -------------------------------------------------------------------

require('dotenv').config();
const express = require('express');
const path = require('path');
const morgan = require('morgan');
const cors = require('cors');
const fs = require('fs');
const Database = require('better-sqlite3');

// ==== env ====
const PORT = Number(process.env.PORT || 3000);
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data.db');
const PUBLIC_DIR = process.env.PUBLIC_DIR || path.join(__dirname, 'public');
const GROUP_MAP_PATH = process.env.GROUP_MAP_PATH || path.join(PUBLIC_DIR, 'group-map.json');
const NAME_KEYS_PATH = process.env.NAME_KEYS_PATH || path.join(PUBLIC_DIR, 'name-keys.json');
const CORS_ORIGIN = process.env.CORS_ORIGIN || '';
const MAX_TITLE_LEN = Number(process.env.MAX_TITLE_LEN || 150); // 窗口标题最大允许字符数

const CLEAN_MODE = (process.env.CLEAN_MODE || 'keep-one').toLowerCase(); // keep-one | wipe
const CLEAR_HOUR = Number(process.env.CLEAR_HOUR || 3);
const CLEAR_MINUTE = Number(process.env.CLEAR_MINUTE || 5);
const charLen = (s) => [...String(s)].length;

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
db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    machine TEXT NOT NULL,
    window_title TEXT,
    app TEXT,
    access_time TEXT NOT NULL,
    raw_json TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_events_machine_time ON events(machine, access_time DESC);
  -- 复合索引，匹配 keep-one 的排序（machine, access_time DESC, id DESC）
  CREATE INDEX IF NOT EXISTS idx_events_machine_time_id ON events(machine, access_time DESC, id DESC);
`);

// SQLite 版本检测：窗口函数需 >= 3.25.0
function sqliteVersionAtLeast(target) {
  try {
    const v = db.prepare(`select sqlite_version() as v`).get().v || '3.25.0';
    const toNums = (s) => String(s).split('.').map(n => parseInt(n, 10) || 0);
    const [a1, a2, a3] = toNums(v);
    const [b1, b2, b3] = toNums(target);
    if (a1 !== b1) return a1 > b1;
    if (a2 !== b2) return a2 > b2;
    return a3 >= b3;
  } catch {
    return false;
  }
}
const SUPPORTS_WINDOW_FN = sqliteVersionAtLeast('3.25.0');

// ==== 5 秒软缓存：group-map & name-keys ====
let __gmCache = null, __gmTS = 0;
let __nkCache = null, __nkTS = 0;

function safeReadJSON(candidates) {
  for (const p of candidates.filter(Boolean)) {
    try {
      if (fs.existsSync(p)) {
        const txt = fs.readFileSync(p, 'utf8');
        return JSON.parse(txt || '{}');
      }
    } catch (e) {
      console.warn('[readJSON] failed:', p, e.message);
    }
  }
  return {};
}

function readGroupMap() {
  const now = Date.now();
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
  const now = Date.now();
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

// 倒排：key -> name
function keyToNameMap() {
  const nk = readNameKeys();
  const out = {};
  Object.keys(nk || {}).forEach(name => {
    const key = nk[name];
    if (typeof key === 'string' && key.trim()) out[key.trim()] = name;
  });
  return out;
}

function getMachinesByName(name) {
  if (!name) return [];
  const map = readGroupMap();
  if (Object.prototype.hasOwnProperty.call(map, name)) {
    const arr = map[name];
    return Array.isArray(arr) ? arr : [];
  }
  return [];
}

// ==== 鉴权（按人按密钥）====
function requirePerUserKey(req, res, next) {
  const keys = keyToNameMap();
  const hasAnyKey = Object.keys(keys).length > 0;
  if (!hasAnyKey) {
    // 没配置 name-keys.json：回退为“无鉴权”（方便本地调试）
    return next();
  }

  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';

  if (!token) return res.status(401).json({ error: 'Unauthorized: missing Bearer token' });

  const name = keys[token];
  if (!name) return res.status(401).json({ error: 'Unauthorized: invalid key' });

  // 将识别出的 name 放到 req 上，供后续使用
  req.__personName = name;
  next();
}

// ==== API ====

// 健康检查
app.get('/api/health', (_req, res) => res.json({ ok: true }));

// 供前端读取 group-map
app.get('/api/group-map', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(readGroupMap());
});

// 可选：查看有哪些名字（不返回密钥）
app.get('/api/names', (_req, res) => {
  res.json({ names: Object.keys(readGroupMap()) });
});

// 上报（服务器时间为准；按密钥校验人名与机器白名单）
app.post('/api/ingest', requirePerUserKey, (req, res) => {
  const body = req.body || {};
  const machine = body.machine || body.machine_id;
  if (!machine) return res.status(400).json({ error: 'machine is required' });

  // 如果配置了 name-keys.json，这里一定有 req.__personName
  const person = req.__personName;
  if (person) {
    const allowList = getMachinesByName(person);
    if (!allowList.includes(machine)) {
      return res.status(403).json({
        error: 'machine not allowed for this key',
        name: person,
        machine,
      });
    }
  } else {
    // 未配置 name-keys.json：也做一层“全局白名单”校验（可选）
    const allAllowed = new Set(
      Object.values(readGroupMap()).flat().filter(Boolean)
    );
    if (allAllowed.size && !allAllowed.has(machine)) {
      return res.status(403).json({ error: 'machine not allowed (no key mode)', machine });
    }
  }

  // === 新增：window_title 长度限制 ===
  const title = body.window_title != null ? String(body.window_title) : null;
  if (title && charLen(title) > MAX_TITLE_LEN) {
    return res.status(400).json({
      error: 'window_title too long',
      limit: MAX_TITLE_LEN,
      length: charLen(title),
    });
  }

  // 服务器时间
  let t = null;
  if (body.event_time) {
    const dt = new Date(body.event_time);
    if (!isNaN(dt.getTime())) t = dt;
  }
  if (!t) t = new Date();

  db.prepare(`
    INSERT INTO events (machine, window_title, app, access_time, raw_json)
    VALUES (@machine, @window_title, @app, @access_time, @raw_json)
  `).run({
    machine: String(machine),
    window_title: body.window_title ? String(body.window_title) : null,
    app: body.app ? String(body.app) : null,
    access_time: t.toISOString(),
    raw_json: body.raw ? JSON.stringify(body.raw) : null,
  });

  res.json({ ok: true });
});

// 查询：GET /api/current-status?name=澜轶 或 ?machine=lanyi-desktop
app.get('/api/current-status', (req, res) => {
  const q = req.query || {};
  const name = q.name;
  const machine = q.machine;
  const limit = Math.min(parseInt(q.limit, 10) || 50, 500);

  let machineList = null;
  if (name) machineList = Array.from(new Set(getMachinesByName(name) || []));
  if (machine) machineList = machineList ? machineList.filter(m => m === machine) : [String(machine)];

  let rows = [];
  if (machineList) {
    if (!machineList.length) return res.json([]);
    const placeholders = machineList.map(() => '?').join(',');
    const sql = `
      SELECT machine, window_title, app, access_time
      FROM events
      WHERE machine IN (${placeholders})
      ORDER BY access_time DESC
      LIMIT ?
    `;
    const stmt = db.prepare(sql);
    rows = stmt.all(...machineList, limit);
  } else {
    rows = db.prepare(`
      SELECT machine, window_title, app, access_time
      FROM events
      ORDER BY access_time DESC
      LIMIT ?
    `).all(limit);
  }
  res.json(rows);
});

// 每台机器的最新一条（便于验证 keep-one 结果）
app.get('/api/current-latest', (_req, res) => {
  const rows = db.prepare(`
    SELECT e.machine, e.window_title, e.app, e.access_time FROM events e
    JOIN (
      SELECT machine, MAX(access_time) AS max_time
      FROM events
      GROUP BY machine
    ) m ON e.machine = m.machine AND e.access_time = m.max_time
    ORDER BY e.machine ASC
  `).all();
  res.json(rows);
});

// 静态资源
app.use('/', express.static(PUBLIC_DIR));

// 兜底 404
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

// ==== 清理任务 ====

// 收缩 WAL/SHM 与主库
function checkpointAndCompact() {
  try {
    db.prepare('PRAGMA wal_checkpoint(TRUNCATE);').run();
    db.exec('VACUUM;');
  } catch (e) {
    console.warn('[vacuum] failed:', e.message);
  }
}

function msUntil(hour, minute) {
  const now = new Date();
  const t = new Date(now);
  t.setHours(hour, minute, 0, 0);
  if (t <= now) t.setDate(t.getDate() + 1);
  return t - now;
}

// 模式一：每天清空
function scheduleDailyWipe() {
  function wipeOnce() {
    try {
      db.exec('BEGIN');
      const n = db.prepare('DELETE FROM events').run().changes;
      db.exec('COMMIT');
      console.log('[wipe] cleared all events, deleted=' + n);
      checkpointAndCompact();
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch {}
      console.error('[wipe] failed:', e.message);
    }
  }
  setTimeout(() => { wipeOnce(); setInterval(wipeOnce, 24*60*60*1000); },
             msUntil(CLEAR_HOUR, CLEAR_MINUTE));
}

// 模式二：每天“每机保留最新一条”（修复 NOT IN 问题，支持窗口函数/降级 EXISTS）
function scheduleDailyKeepOnePerMachine() {
  const SQL_WINDOW =
    `WITH ranked AS (
       SELECT id,
              ROW_NUMBER() OVER (
                PARTITION BY machine
                ORDER BY access_time DESC, id DESC
              ) AS rn
       FROM events
     )
     DELETE FROM events
     WHERE id IN (SELECT id FROM ranked WHERE rn > 1)`;

  const SQL_EXISTS =
    `DELETE FROM events AS old
     WHERE EXISTS (
       SELECT 1
       FROM events AS newer
       WHERE newer.machine = old.machine
         AND (
           newer.access_time > old.access_time OR
           (newer.access_time = old.access_time AND newer.id > old.id)
         )
     )`;

  function keepOnce() {
    try {
      db.exec('BEGIN');
      // 确保复合索引存在（幂等）
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_events_machine_time_id
        ON events(machine, access_time DESC, id DESC);
      `);

      const sql = SUPPORTS_WINDOW_FN ? SQL_WINDOW : SQL_EXISTS;
      const info = db.prepare(sql).run();
      db.exec('COMMIT');

      console.log('[keep-one] deleted=' + info.changes +
                  ` (kept latest row per machine; engine=${SUPPORTS_WINDOW_FN ? 'window-fn' : 'exists'})`);

      // 事务提交后再做收缩
      checkpointAndCompact();
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch {}
      console.error('[keep-one] failed:', e.message);
    }
  }

  setTimeout(() => { keepOnce(); setInterval(keepOnce, 24*60*60*1000); },
             msUntil(CLEAR_HOUR, CLEAR_MINUTE));
}

if (CLEAN_MODE === 'wipe') {
  console.log('[cleanup] mode=wipe at ' + CLEAR_HOUR + ':' + CLEAR_MINUTE);
  scheduleDailyWipe();
} else {
  console.log('[cleanup] mode=keep-one at ' + CLEAR_HOUR + ':' + CLEAR_MINUTE +
              ` (window-fn=${SUPPORTS_WINDOW_FN})`);
  scheduleDailyKeepOnePerMachine();
}

// ==== start ====
app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
  console.log(`DB: ${DB_PATH}`);
  console.log(`Public: ${PUBLIC_DIR}`);
  console.log(`GroupMap: ${GROUP_MAP_PATH}`);
  console.log(`NameKeys: ${NAME_KEYS_PATH}`);
});
