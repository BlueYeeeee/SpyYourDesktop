'use strict';

const http = require('http');
const https = require('https');

const VERSION = '1.0.0';

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 2 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 2 });

class UploadTransportError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'UploadTransportError';
    this.cause = cause || null;
  }
}

function postJson(urlString, body, headers, options) {
  const opts = options || {};
  let u;
  try {
    u = new URL(urlString);
  } catch (e) {
    return Promise.reject(new UploadTransportError('服务器地址不是合法 URL', e));
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return Promise.reject(new UploadTransportError('服务器地址必须使用 http/https'));
  }

  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  const isHttps = u.protocol === 'https:';
  const lib = isHttps ? https : http;

  return new Promise((resolve, reject) => {
    let settled = false;
    const req = lib.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (isHttps ? 443 : 80),
        path: u.pathname + u.search,
        method: 'POST',
        headers: Object.assign(
          {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Length': payload.length,
            'User-Agent': 'SpyYourDesktop-Linux/' + VERSION,
            'X-OS': 'Linux',
            'X-App-Version': VERSION,
            Accept: 'application/json',
          },
          headers || {}
        ),
        agent: isHttps ? httpsAgent : httpAgent,
      },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > 1024 * 1024) {
            req.destroy(new Error('响应超过 1MB'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          if (settled) return;
          settled = true;
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch (_) {
            // not JSON
          }
          resolve({ status: res.statusCode || 0, headers: res.headers, text, json });
        });
        res.on('error', (err) => {
          if (settled) return;
          settled = true;
          reject(new UploadTransportError('读取服务器响应失败：' + err.message, err));
        });
      }
    );

    req.setTimeout(opts.timeoutMs || 15000, () => {
      req.destroy(new Error('请求超时'));
    });

    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(new UploadTransportError('连接服务器失败：' + err.message, err));
    });

    req.end(payload);
  });
}

function buildUploadPayload(config, windowInfo, reason) {
  const raw = {
    source: windowInfo.source || 'unknown',
    pid: windowInfo.pid || 0,
    session: windowInfo.session || null,
    desktop: windowInfo.desktop || null,
    reason: reason || 'change',
  };
  if (windowInfo.noWindow) raw.no_window = true;

  return {
    machine: config.machineId,
    window_title: windowInfo.title || '',
    app: windowInfo.app || '',
    os: 'Linux',
    app_version: VERSION,
    raw,
  };
}

async function upload(config, windowInfo, reason) {
  const headers = {};
  const key = String(config.uploadKey || '').trim();
  if (key) {
    headers.Authorization = /^Bearer\s/i.test(key) ? key : 'Bearer ' + key;
    headers['X-Name-Key'] = key.replace(/^Bearer\s+/i, '');
  }
  const body = buildUploadPayload(config, windowInfo, reason);
  return postJson(config.serverUrl, body, headers);
}

function parseRetryAfterMs(response) {
  const json = response && response.json;
  if (json && Number.isFinite(Number(json.retry_after_ms))) {
    return Math.max(0, Number(json.retry_after_ms));
  }
  const h = response && response.headers && response.headers['retry-after'];
  if (h) {
    const sec = Number(h);
    if (Number.isFinite(sec)) return Math.max(0, sec * 1000);
  }
  return 4000;
}

function serverErrorSummary(response) {
  if (!response) return '无响应';
  const json = response.json;
  if (json && typeof json === 'object') {
    const parts = [];
    if (json.error) parts.push(String(json.error));
    if (json.message) parts.push(String(json.message));
    if (parts.length) return parts.join(' - ');
  }
  const text = String(response.text || '').trim();
  return text ? text.slice(0, 500) : 'HTTP ' + response.status;
}

module.exports = {
  VERSION,
  UploadTransportError,
  postJson,
  buildUploadPayload,
  upload,
  parseRetryAfterMs,
  serverErrorSummary,
};
