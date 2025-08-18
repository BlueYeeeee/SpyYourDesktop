// server.js  —— Node 12 兼容版（CommonJS），支持 /api 与无 /api 前缀两套路由
require('dotenv').config();
const express = require('express');
const path = require('path');
const morgan = require('morgan');
const cors = require('cors');
const Database = require('better-sqlite3');

// === env ===
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const API_KEY = process.env.API_KEY || 'dev-key';
const DB_PATH = process.env.DB_PATH || './data.db';

// === app ===
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));
app.use(morgan('dev'));

// 仅给 API 开 CORS（静态文件同域访问）
const apiCors = cors({ origin: true, credentials: false });

// === db ===
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(
  "CREATE TABLE IF NOT EXISTS events (" +
  " id INTEGER PRIMARY KEY AUTOINCREMENT," +
  " machine TEXT NOT NULL," +
  " window_title TEXT," +
  " app TEXT," +
  " access_time TEXT NOT NULL," + // ISO 字符串
  " raw_json TEXT" +
  ");"
);
db.exec("CREATE INDEX IF NOT EXISTS idx_events_machine_time ON events(machine, access_time DESC);");

// === auth（仅用于写入） ===
function requireBearer(req, res, next) {
  var header = req.headers.authorization || '';
  var token = header.indexOf('Bearer ') === 0 ? header.slice(7) : '';
  if (token !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// 同时兼容 ingest/report 两种字段名（不使用 ??/?.）
function normalizeEvent(body) {
  body = body || {};
  var machine = body.machine != null ? body.machine : body.machine_id;
  var window_title = body.window_title || null;
  var app = body.app != null ? body.app : body.app_name;
  if (app == null) app = null;
  var when = body.event_time != null ? body.event_time : body.access_time;
  if (!when) when = new Date().toISOString();
  var raw = body.raw || null;
  return { machine: machine, window_title: window_title, app: app, when: when, raw: raw };
}

function handleIngest(req, res) {
  var ev = normalizeEvent(req.body);
  if (!ev.machine) return res.status(400).json({ error: 'machine is required' });

  var t = new Date(ev.when);
  if (isNaN(t.getTime())) return res.status(400).json({ error: 'invalid time' });

  var insert = db.prepare(
    "INSERT INTO events (machine, window_title, app, access_time, raw_json) " +
    "VALUES (@machine, @window_title, @app, @access_time, @raw_json)"
  );
  insert.run({
    machine: ev.machine,
    window_title: ev.window_title || null,
    app: ev.app || null,
    access_time: t.toISOString(),
    raw_json: ev.raw ? JSON.stringify(ev.raw) : null
  });

  res.json({ ok: true });
}

// --- 健康检查（两条路径都支持）
app.get(['/api/health', '/health'], function (_req, res) {
  res.json({ ok: true, now: new Date().toISOString(), pid: process.pid });
});

// --- 预检（避免 405），两套前缀都放行
app.options(['/api/ingest', '/api/report', '/ingest', '/report'], apiCors, function (_req, res) {
  res.sendStatus(204);
});

// --- 上报路由：同时支持带/不带 /api 前缀
app.post(['/api/ingest', '/ingest'], apiCors, requireBearer, handleIngest);
app.post(['/api/report', '/report'], apiCors, requireBearer, handleIngest);

// --- 查询当前状态（两条别名）：GET (/api)/current-status?machine=xxx&limit=50
app.get(['/api/current-status', '/current-status'], apiCors, function (req, res) {
  var machine = req.query.machine;
  var n = parseInt(req.query.limit, 10);
  if (isNaN(n) || n <= 0) n = 50;
  if (n > 500) n = 500;

  var rows;
  if (machine) {
    rows = db.prepare(
      "SELECT machine, window_title, app, access_time " +
      "FROM events WHERE machine = ? ORDER BY access_time DESC LIMIT ?"
    ).all(machine, n);
  } else {
    rows = db.prepare(
      "SELECT machine, window_title, app, access_time " +
      "FROM events ORDER BY access_time DESC LIMIT ?"
    ).all(n);
  }
  res.json(rows);
});

// --- 每台机器最新一条（两条别名）
app.get(['/api/current-latest', '/current-latest'], apiCors, function (_req, res) {
  var rows = db.prepare(
    "SELECT e.machine, e.window_title, e.app, e.access_time FROM events e " +
    "JOIN (SELECT machine, MAX(access_time) AS max_time FROM events GROUP BY machine) m " +
    "ON e.machine = m.machine AND e.access_time = m.max_time " +
    "ORDER BY e.machine ASC"
  ).all();
  res.json(rows);
});

// 静态网页（public/index.html）
app.use('/', express.static(path.join(__dirname, 'public')));

// 兜底 404
app.use(function (req, res) {
  res.status(404).json({ error: 'Not found', method: req.method, url: req.originalUrl });
});

// 统一错误处理
app.use(function (err, _req, res, _next) {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'internal', detail: err && err.message });
});

app.listen(PORT, HOST, function () {
  console.log("Server listening on http://" + HOST + ":" + PORT);
});
