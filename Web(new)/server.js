// server.js  (Node 12 兼容 / CommonJS) —— 仅个人密钥鉴权版（无全局 API_KEY）
require('dotenv').config();
const express = require('express');
const path = require('path');
const morgan = require('morgan');
const cors = require('cors');
const fs = require('fs');
const Database = require('better-sqlite3');

// ========= ENV =========
const PORT = Number(process.env.PORT || 3000);
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data.db');
const CORS_ORIGIN = process.env.CORS_ORIGIN || '';
const PUBLIC_DIR = process.env.PUBLIC_DIR || path.join(__dirname, 'public');
const GROUP_MAP_PATH = process.env.GROUP_MAP_PATH || path.join(PUBLIC_DIR, 'group-map.json');
const NAME_KEYS_PATH = process.env.NAME_KEYS_PATH || path.join(PUBLIC_DIR, 'name-keys.json');

// ========= APP =========
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));
app.use(morgan('dev'));
if (CORS_ORIGIN) {
  app.use(cors({ origin: (_o, cb) => cb(null, true), credentials: false }));
}

// ========= DB =========
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
`);

// ========= 小缓存读取（5s）=========
function readJSONCached(filePath, box, ttlMs) {
  try {
    const now = Date.now();
    if (!box.cache || now - box.ts > ttlMs) {
      const raw = fs.readFileSync(filePath, 'utf8');
      box.cache = JSON.parse(raw || '{}');
      box.ts = now;
    }
    return box.cache || {};
  } catch (e) {
    return {};
  }
}
const __gmBox = { cache: null, ts: 0 };   // group-map
const __nkBox = { cache: null, ts: 0 };   // name-keys

function readGroupMap() {
  return readJSONCached(GROUP_MAP_PATH, __gmBox, 5000);
}
function readNameKeys() {
  return readJSONCached(NAME_KEYS_PATH, __nkBox, 5000);
}

// 根据名字取机器列表
function getMachinesByName(name) {
  if (!name) return [];
  const map = readGroupMap();
  if (Array.isArray(map[name])) return map[name];
  const target = String(name).trim();
  for (const k of Object.keys(map)) {
    if (String(k).trim() === target) return Array.isArray(map[k]) ? map[k] : [];
  }
  return [];
}

// 根据 machine 反查归属人名（可能多个）
function resolveOwnersByMachine(machine) {
  const map = readGroupMap();
  const owners = [];
  for (const k of Object.keys(map)) {
    const arr = Array.isArray(map[k]) ? map[k] : [];
    if (arr.includes(machine)) owners.push(k);
  }
  return owners;
}

// machine 是否在白名单（group-map.json）
function machineAllowed(machine) {
  const map = readGroupMap();
  for (const k of Object.keys(map)) {
    const arr = Array.isArray(map[k]) ? map[k] : [];
    if (arr.includes(machine)) return true;
  }
  return false;
}

// 解析 Authorization: Bearer xxx
function parseBearer(req) {
  const h = String(req.headers['authorization'] || '');
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? String(m[1]).trim() : '';
}

// token 是否属于该 machine 的归属人（在 name-keys.json 中）
function tokenValidForMachine(token, machine) {
  if (!token) return false;
  const owners = resolveOwnersByMachine(machine);
  const nk = readNameKeys();
  for (const name of owners) {
    const list = Array.isArray(nk[name]) ? nk[name] : [];
    if (list.includes(token)) return true;
  }
  return false;
}

// ========= 鉴权中间件（只允许：个人密钥 + 白名单 machine）=========
function requireBearer(req, res, next) {
  const body = req.body || {};
  const machine = String(body.machine || body.machine_id || '').trim();
  if (!machine) return res.status(400).json({ error: 'machine is required' });

  if (!machineAllowed(machine)) {
    return res.status(403).json({ error: 'machine not allowed (not in group-map)', machine });
  }

  const token = parseBearer(req);
  if (!token) return res.status(401).json({ error: 'missing Authorization Bearer token' });

  if (tokenValidForMachine(token, machine)) return next();

  return res.status(401).json({ error: 'bad token for this machine', machine });
}

// ========= API =========
// 健康检查
app.get('/api/health', (req, res) => res.json({ ok: true }));

// 前端读取 group-map.json
app.get('/api/group-map', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(readGroupMap());
});

// 上报：POST /api/ingest
// body: { machine/machine_id, window_title, app, event_time, raw }
app.post('/api/ingest', requireBearer, (req, res) => {
  const body = req.body || {};
  const machine = body.machine || body.machine_id;

  const t = body.event_time ? new Date(body.event_time) : new Date();
  if (isNaN(t.getTime())) return res.status(400).json({ error: 'invalid event_time' });

  const insert = db.prepare(`
    INSERT INTO events (machine, window_title, app, access_time, raw_json)
    VALUES (@machine, @window_title, @app, @access_time, @raw_json)
  `);
  insert.run({
    machine: String(machine),
    window_title: body.window_title ? String(body.window_title) : null,
    app: body.app ? String(body.app) : null,
    access_time: t.toISOString(),
    raw_json: body.raw ? JSON.stringify(body.raw) : null,
  });

  res.json({ ok: true });
});

// 查询：GET /api/current-status
// - /api/current-status?name=澜轶&limit=50     -> 读取该名下所有机器的时间线（降序）
// - /api/current-status?machine=lanyi-desktop  -> 单机
// - 不传参数 -> 全部
app.get('/api/current-status', (req, res) => {
  const q = req.query || {};
  const name = q.name;
  const machine = q.machine;
  const limit = Math.min(parseInt(q.limit, 10) || 50, 500);

  let machineList = null;
  if (name) {
    const list = getMachinesByName(name);
    machineList = Array.isArray(list) ? Array.from(new Set(list)) : [];
  }
  if (machine) {
    if (machineList) {
      // 同时传了 name+machine -> 取交集
      machineList = machineList.filter(m => m === machine);
    } else {
      machineList = [String(machine)];
    }
  }

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
    const stmt = db.prepare(`
      SELECT machine, window_title, app, access_time
      FROM events
      ORDER BY access_time DESC
      LIMIT ?
    `);
    rows = stmt.all(limit);
  }

  res.json(rows);
});

// 每台机器的最新一条
app.get('/api/current-latest', (req, res) => {
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

// 静态文件（index.html / group-map.json / name-keys.json / 壁纸等）
app.use('/', express.static(PUBLIC_DIR));

// 兜底 404
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
  console.log(`DB: ${DB_PATH}`);
  console.log(`Public: ${PUBLIC_DIR}`);
  console.log(`GroupMap: ${GROUP_MAP_PATH}`);
  console.log(`NameKeys: ${NAME_KEYS_PATH}`);
});
