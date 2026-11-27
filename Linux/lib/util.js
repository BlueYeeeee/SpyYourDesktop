'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

function run(cmd, args, options) {
  const opts = options || {};
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args || [],
      {
        encoding: 'utf8',
        timeout: opts.timeout || 3000,
        maxBuffer: opts.maxBuffer || 4 * 1024 * 1024,
        env: opts.env || process.env,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        if (err) {
          const detail = (stderr || '').trim();
          const e = new Error(
            cmd + ' failed: ' + err.message + (detail ? ' | ' + detail : '')
          );
          e.code = err.code;
          e.stdout = stdout || '';
          e.stderr = stderr || '';
          e.notFound = err.code === 'ENOENT';
          reject(e);
          return;
        }
        resolve(stdout || '');
      }
    );
  });
}

function findCommand(name) {
  if (!name) return null;
  const dirs = String(process.env.PATH || '').split(path.delimiter);
  for (const dir of dirs) {
    if (!dir) continue;
    const p = path.join(dir, name);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch (_) {
      // keep looking
    }
  }
  return null;
}

function commandExists(name) {
  return !!findCommand(name);
}

/**
 * Parse "xprop -root _NET_ACTIVE_WINDOW".
 * Example: _NET_ACTIVE_WINDOW(WINDOW): window id # 0x3e00007
 */
function parseXpropActiveWindow(output) {
  const m = /window id\s*#\s*(0x[0-9a-fA-F]+|\d+)/.exec(String(output || ''));
  if (!m) return null;
  const id = m[1].toLowerCase();
  if (id === '0x0' || id === '0') return null;
  return id;
}

function unescapeXpropString(value) {
  return String(value).replace(/\\([0-7]{1,3}|x[0-9a-fA-F]{2}|.)/g, (all, esc) => {
    if (/^[0-7]+$/.test(esc)) return String.fromCharCode(parseInt(esc, 8));
    if (esc[0] === 'x' && esc.length === 3) {
      return String.fromCharCode(parseInt(esc.slice(1), 16));
    }
    switch (esc) {
      case 'n':
        return '\n';
      case 't':
        return '\t';
      case 'r':
        return '\r';
      case '"':
        return '"';
      case '\\':
        return '\\';
      default:
        return esc;
    }
  });
}

function parseQuotedXpropValue(raw) {
  const m = /^"(.*)"\s*$/s.exec(String(raw || '').trim());
  if (!m) return null;
  return unescapeXpropString(m[1]);
}

/**
 * Parse the output of:
 *   xprop -id <id> -notype _NET_WM_NAME WM_NAME _NET_WM_PID WM_CLASS
 * Returns { title, pid, app } where any value may be null.
 */
function parseXpropWindow(output) {
  const result = { title: null, pid: null, app: null };
  const lines = String(output || '').split(/\r?\n/);
  const props = {};
  for (const line of lines) {
    const m = /^([A-Za-z0-9_]+)(?:\([^)]*\))?\s*=\s*(.*)$/.exec(line.trim());
    if (m) props[m[1]] = m[2];
  }

  if (props._NET_WM_NAME != null) {
    const v = parseQuotedXpropValue(props._NET_WM_NAME);
    if (v != null) result.title = v;
  }
  if (result.title == null && props.WM_NAME != null) {
    const v = parseQuotedXpropValue(props.WM_NAME);
    if (v != null) result.title = v;
  }

  if (props._NET_WM_PID != null) {
    const m = /(\d+)/.exec(props._NET_WM_PID);
    if (m) result.pid = parseInt(m[1], 10);
  }

  if (props.WM_CLASS != null) {
    const quoted = [];
    const re = /"((?:\\.|[^"\\])*)"/g;
    let m;
    while ((m = re.exec(props.WM_CLASS)) !== null) {
      quoted.push(unescapeXpropString(m[1]));
    }
    if (quoted.length) result.app = quoted[quoted.length - 1];
  }

  return result;
}

function findFocusedSwayNode(node) {
  if (!node || typeof node !== 'object') return null;
  if (node.focused === true) return node;
  const groups = [node.nodes, node.floating_nodes];
  for (const group of groups) {
    if (!Array.isArray(group)) continue;
    for (const child of group) {
      const hit = findFocusedSwayNode(child);
      if (hit) return hit;
    }
  }
  return null;
}

function parseSwayTree(output) {
  let tree;
  try {
    tree = JSON.parse(String(output || ''));
  } catch (_) {
    return null;
  }
  const node = findFocusedSwayNode(tree);
  if (!node) return null;
  const props = node.window_properties || {};
  return {
    title: node.name || '',
    app: node.app_id || props.class || props.instance || '',
    pid: Number(node.pid) || 0,
  };
}

/**
 * Parse "hyprctl activewindow -j" (Hyprland).
 */
function parseHyprlandWindow(output) {
  let data;
  try {
    data = JSON.parse(String(output || ''));
  } catch (_) {
    return null;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const title = data.title || '';
  const app = data.class || data.initialClass || '';
  const pid = Number(data.pid) || 0;
  if (!title && !app) return null;
  return { title, app, pid };
}

/**
 * Parse "wlrctl toplevel list state:focused". Each line is "app-id: title".
 */
function parseWlrctlList(output) {
  const lines = String(output || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!lines.length) return null;
  const line = lines[0];
  const idx = line.indexOf(': ');
  if (idx < 0) {
    const idx2 = line.indexOf(':');
    if (idx2 < 0) return { title: line, app: '', pid: 0 };
    return {
      title: line.slice(idx2 + 1).trim(),
      app: line.slice(0, idx2).trim(),
      pid: 0,
    };
  }
  return {
    title: line.slice(idx + 2).trim(),
    app: line.slice(0, idx).trim(),
    pid: 0,
  };
}

function sanitizeText(value, maxLength) {
  let s = String(value == null ? '' : value);
  s = s.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  const limit = Number(maxLength) > 0 ? Number(maxLength) : 150;
  if (s.length > limit) s = s.slice(0, limit);
  return s;
}

function truncateText(value, maxLength) {
  const s = String(value == null ? '' : value);
  const limit = Number(maxLength) > 0 ? Number(maxLength) : 150;
  return s.length > limit ? s.slice(0, limit) : s;
}

function readFileSafe(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (_) {
    return null;
  }
}

module.exports = {
  run,
  findCommand,
  commandExists,
  parseXpropActiveWindow,
  parseXpropWindow,
  parseQuotedXpropValue,
  unescapeXpropString,
  parseSwayTree,
  findFocusedSwayNode,
  parseHyprlandWindow,
  parseWlrctlList,
  sanitizeText,
  truncateText,
  readFileSafe,
};
