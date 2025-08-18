import 'dotenv/config';
import activeWin from 'active-win';
import fetch from 'node-fetch';

// ==== 配置 ====
const RAW_SERVER_URL = process.env.SERVER_URL || 'http://localhost:3000';
const SERVER_URL = RAW_SERVER_URL.replace(/\/+$/, '');  // 去掉末尾斜杠，避免 //api
const API_KEY = process.env.API_KEY || 'dev-key';
const MACHINE_ID = process.env.MACHINE_ID || 'my-pc';
const INTERVAL_MS = parseInt(process.env.INTERVAL_MS || '3000', 10);

// 心跳：即使标题未变，也在该间隔后强制上报一次
const HEARTBEAT_MS = parseInt(process.env.HEARTBEAT_MS || '10000', 10);

// 每次轮询都上报（用于调试/保活）
const ALWAYS_SEND = (process.env.ALWAYS_SEND || 'false').toLowerCase() === 'true';

// ==== 运行时状态 ====
let lastTitle = null;
let lastApp = null;
let lastSentAt = 0;         // Date.now() 时间戳
let busy = false;           // 防重入锁

function sanitize(s) {
  if (!s) return '';
  return String(s).replace(/\s+/g, ' ').trim().slice(0, 512);
}

async function sendEvent(payload, reason = 'change') {
  const res = await fetch(`${SERVER_URL}/api/ingest`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      ...payload,
      raw: { kind: 'client', reason, raw: payload.raw ?? null },
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ingest failed: ${res.status} ${text}`);
  }
}

async function tick() {
  if (busy) return;
  busy = true;
  try {
    let info = null;
    try {
      info = await activeWin();
    } catch (e) {
      // 某些情况下获取前台窗口会失败，继续用上一次数据发心跳
      // console.warn('activeWin failed:', e?.message || e);
    }

    const title = sanitize(info?.title) || sanitize(lastTitle) || '';
    const app = sanitize(info?.owner?.name) || sanitize(lastApp) || '';

    const now = Date.now();
    const changed = title !== (lastTitle || '');
    const dueHeartbeat = (now - lastSentAt) >= HEARTBEAT_MS;

    const shouldSend = ALWAYS_SEND || changed || dueHeartbeat;

    if (shouldSend) {
      await sendEvent({
        machine: MACHINE_ID,
        window_title: title,
        app,
        event_time: new Date().toISOString(),
        raw: info || null,
      }, changed ? 'change' : (ALWAYS_SEND ? 'always' : 'heartbeat'));

      lastSentAt = now;
      if (changed) { lastTitle = title; lastApp = app; }

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

console.log(`Reporter started. interval=${INTERVAL_MS}ms heartbeat=${HEARTBEAT_MS}ms machine=${MACHINE_ID} -> ${SERVER_URL}`);
setInterval(tick, INTERVAL_MS);
tick();
