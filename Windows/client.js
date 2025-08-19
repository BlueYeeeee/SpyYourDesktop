// client.js — Windows 上报端（服务器统一记时版）
// 依赖：active-win、node-fetch、dotenv
// npm i active-win node-fetch dotenv
import 'dotenv/config';
import activeWin from 'active-win';
import fetch from 'node-fetch';

// ===== 配置 =====
const RAW_SERVER_URL = process.env.SERVER_URL || 'http://localhost:3000';
const SERVER_URL = RAW_SERVER_URL.replace(/\/+$/, ''); // 去尾斜杠，避免 //api
const API_KEY = (process.env.API_KEY || '').trim();    // 可留空 => 不带鉴权头
const MACHINE_ID = process.env.MACHINE_ID || 'my-pc';

const INTERVAL_MS  = parseInt(process.env.INTERVAL_MS  || '7000', 10);  // 轮询间隔
const HEARTBEAT_MS = parseInt(process.env.HEARTBEAT_MS || '13000', 10); // 心跳上报
const ALWAYS_SEND  = (process.env.ALWAYS_SEND || 'false').toLowerCase() === 'true'; // 调试/保活

// ===== 运行状态 =====
let lastTitle = null;
let lastApp = null;
let lastSentAt = 0;   // Date.now()
let busy = false;     // 防重入

function sanitize(s) {
  if (!s) return '';
  return String(s).replace(/\s+/g, ' ').trim().slice(0, 512);
}

function buildHeaders() {
  const h = { 'content-type': 'application/json' };
  // 鉴权可选：如果提供了 API_KEY，就带 Authorization；否则不带
  if (API_KEY) h['authorization'] = `Bearer ${API_KEY}`;
  return h;
}

async function sendEvent(payload, reason = 'change') {
  const res = await fetch(`${SERVER_URL}/api/ingest`, {
    method: 'POST',
    headers: buildHeaders(),
    body: JSON.stringify({
      ...payload,
      // 不再上传 event_time，由服务器统一记时
      raw: { kind: 'client', reason, raw: payload.raw ?? null },
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`ingest failed: ${res.status} ${text || ''}`);
  }
}

async function tick() {
  if (busy) return;
  busy = true;
  try {
    let info = null;
    try {
      info = await activeWin();
    } catch {
      // 获取前台窗口偶发失败就用上一次数据做心跳
    }

    const title = sanitize(info?.title) || sanitize(lastTitle) || '';
    const app   = sanitize(info?.owner?.name) || sanitize(lastApp) || '';

    const now = Date.now();
    const changed      = title !== (lastTitle || '');
    const dueHeartbeat = (now - lastSentAt) >= HEARTBEAT_MS;
    const shouldSend   = ALWAYS_SEND || changed || dueHeartbeat;

    if (shouldSend) {
      await sendEvent(
        {
          machine: MACHINE_ID,
          window_title: title,
          app,
          raw: info || null,
        },
        changed ? 'change' : (ALWAYS_SEND ? 'always' : 'heartbeat')
      );

      lastSentAt = now;
      if (changed) {
        lastTitle = title;
        lastApp   = app;
      }
      const tag = changed ? 'change' : (ALWAYS_SEND ? 'always' : 'heartbeat');
      console.log(`[sent ${tag}] ${new Date().toLocaleTimeString()} | ${app} - ${title}`);
    } else {
      console.log('[skip] unchanged');
    }
  } catch (e) {
    console.error(`[error] ${e?.message || e}`);
  } finally {
    busy = false;
  }
}

console.log(
  `Reporter started. interval=${INTERVAL_MS}ms heartbeat=${HEARTBEAT_MS}ms machine=${MACHINE_ID} -> ${SERVER_URL}` +
  (API_KEY ? ' (auth: on)' : ' (auth: off)')
);

setInterval(tick, INTERVAL_MS);
tick();
