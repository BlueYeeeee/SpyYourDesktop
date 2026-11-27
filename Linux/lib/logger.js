'use strict';

const fs = require('fs');
const path = require('path');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function timestamp(date) {
  const d = date || new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return (
    d.getFullYear() +
    '-' +
    pad(d.getMonth() + 1) +
    '-' +
    pad(d.getDate()) +
    ' ' +
    pad(d.getHours()) +
    ':' +
    pad(d.getMinutes()) +
    ':' +
    pad(d.getSeconds())
  );
}

class Logger {
  constructor(options) {
    const opts = options || {};
    this.level = LEVELS[opts.level] || LEVELS.info;
    this.logPath = opts.logPath || null;
    this.console = opts.console !== false;
    this.quiet = !!opts.quiet;
    this._rotateIfNeeded();
  }

  _rotateIfNeeded() {
    if (!this.logPath) return;
    try {
      fs.mkdirSync(path.dirname(this.logPath), { recursive: true, mode: 0o700 });
      const st = fs.statSync(this.logPath);
      if (st.size > 5 * 1024 * 1024) {
        try {
          fs.renameSync(this.logPath, this.logPath + '.1');
        } catch (_) {
          fs.truncateSync(this.logPath, 0);
        }
      }
    } catch (_) {
      // file does not exist yet
    }
  }

  _write(level, args) {
    if (LEVELS[level] < this.level) return;
    const text = args
      .map((v) => {
        if (v instanceof Error) return v.stack || v.message;
        if (typeof v === 'object') {
          try {
            return JSON.stringify(v);
          } catch (_) {
            return String(v);
          }
        }
        return String(v);
      })
      .join(' ');
    const line = timestamp() + ' [' + level.toUpperCase() + '] ' + text;
    if (this.console && !this.quiet) {
      const out = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
      try {
        out.write(line + '\n');
      } catch (_) {
        // ignore EPIPE
      }
    }
    if (this.logPath) {
      try {
        fs.appendFileSync(this.logPath, line + '\n', { encoding: 'utf8', mode: 0o600 });
      } catch (_) {
        // logging must never crash the client
      }
    }
  }

  debug() {
    this._write('debug', Array.prototype.slice.call(arguments));
  }

  info() {
    this._write('info', Array.prototype.slice.call(arguments));
  }

  warn() {
    this._write('warn', Array.prototype.slice.call(arguments));
  }

  error() {
    this._write('error', Array.prototype.slice.call(arguments));
  }
}

module.exports = { Logger, LEVELS, timestamp };
