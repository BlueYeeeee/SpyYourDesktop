// server.js  (Node 12 兼容 / CommonJS)
require('dotenv').config();
const express = require('express');
const path = require('path');
const morgan = require('morgan');
const cors = require('cors');
const fs = require('fs');
const Database = require('better-sqlite3');

// ==== env ====
const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.API_KEY || 'dev-key';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data.db');
const CORS_ORIGIN = process.env.CORS_ORIGIN || ''; // 为空则不启用 CORS
const PUBLIC_DIR = process.env.PUBLIC_DIR || path.join(__dirname, 'public');
const GROUP_MAP_PATH = process.env.GROUP_MAP_PATH || path.join(PUBLIC_DIR, 'group-map.json');

// ==== app ====
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));
app.use(morgan('dev'));

if (CORS_ORIGIN) {
  app.use(cors({
    origin: function (origin, cb) { cb(null, true); },
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
`);

// ==== auth (仅写入校验) ====
function requireBearer(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token = header.indexOf('Bearer ') === 0 ? header.slice(7) : '';
  if (token !== API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ==== group-map 读取 + 5s 软缓存 ====
let __gmCache = null;
let __gmTS = 0;
function readGroupMap() {
  try {
    const now = Date.now();
    if (!__gmCache || now - __gmTS > 5000) {
      // 允许三个候选路径，按优先级读取
      const candidates = [
        GROUP_MAP_PATH,                                 // 环境变量自定义/默认 public/group-map.json
        path.join(__dirname, 'public', 'group-map.json'),
        path.join(__dirname, 'group-map.json'),
      ];
      let loaded = null;
      for (const p of candidates) {
        try {
          if (p && fs.existsSync(p)) {
            loaded = JSON.parse(fs.readFileSync(p, 'utf8') || '{}');
            break;
          }
        } catch (e) {
          console.error('[group-map] read/parse failed:', p, e.message);
        }
      }
      __gmCache = loaded || {};
      __gmTS = now;
    }
    return __gmCache || {};
  } catch (e) {
    return {};
  }
}
function getMachinesByName(name) {
  if (!name) return null;
  const map = readGroupMap();
  if (map[name]) return Array.isArray(map[name]) ? map[name] : [];
  const target = String(name).trim();
  for (const k of Object.keys(map)) {
    if (String(k).trim() === target) return Array.isArray(map[k]) ? map[k] : [];
  }
  return [];
}

// ==== API ====

// 健康检查
app.get('/api/health', (req, res) => res.json({ ok: true }));

// 供前端/机器人读取 group-map
app.get('/api/group-map', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(readGroupMap());
});

// 上报：POST /api/ingest
// body: { machine/machine_id, window_title, app, event_time, raw }
app.post('/api/ingest', requireBearer, (req, res) => {
  const body = req.body || {};
  const machine = body.machine || body.machine_id;
  if (!machine) return res.status(400).json({ error: 'machine is required' });

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
// - /api/current-status?name=ID&limit=50     -> 读取 group-map 中该名字关联的所有机器
// - /api/current-status?machine=machine-id  -> 单机
// - 未传任何参数 -> 全部
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
      // 同时给了 name 和 machine -> 取交集
      machineList = machineList.filter(m => m === String(machine));
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

// 静态文件（前端 index.html、group-map.json 等）
app.use('/', express.static(PUBLIC_DIR));

// 兜底 404（静态之外的未知路由）
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
  console.log(`DB: ${DB_PATH}`);
  console.log(`Public: ${PUBLIC_DIR}`);
  console.log(`GroupMap: ${GROUP_MAP_PATH}`);
});
