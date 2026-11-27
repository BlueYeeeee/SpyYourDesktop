'use strict';

const assert = require('assert');
const {
  parseXpropActiveWindow,
  parseXpropWindow,
  parseQuotedXpropValue,
  parseSwayTree,
  parseHyprlandWindow,
  parseWlrctlList,
  sanitizeText,
} = require('../lib/util');
const { normalizeServerUrl, normalizeConfig, quoteDesktopExecArg } = require('../lib/config');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('ok - ' + name);
  } catch (e) {
    console.error('not ok - ' + name);
    throw e;
  }
}

test('parse _NET_ACTIVE_WINDOW', () => {
  assert.strictEqual(
    parseXpropActiveWindow('_NET_ACTIVE_WINDOW(WINDOW): window id # 0x3e00007'),
    '0x3e00007'
  );
  assert.strictEqual(
    parseXpropActiveWindow('_NET_ACTIVE_WINDOW: window id # 123'),
    '123'
  );
  assert.strictEqual(
    parseXpropActiveWindow('_NET_ACTIVE_WINDOW(WINDOW): window id # 0x0'),
    null
  );
});

test('parse xprop window properties', () => {
  const out = [
    '_NET_WM_NAME(UTF8_STRING) = "Hello \\"world\\""',
    'WM_NAME(STRING) = "fallback"',
    '_NET_WM_PID(CARDINAL) = 4242',
    'WM_CLASS(STRING) = "instance-name", "Class-Name"',
  ].join('\n');
  const info = parseXpropWindow(out);
  assert.strictEqual(info.title, 'Hello "world"');
  assert.strictEqual(info.pid, 4242);
  assert.strictEqual(info.app, 'Class-Name');
});

test('parse xprop WM_NAME fallback', () => {
  const info = parseXpropWindow('WM_NAME(STRING) = "Only WM_NAME"');
  assert.strictEqual(info.title, 'Only WM_NAME');
  assert.strictEqual(info.app, null);
});

test('quoted xprop value unescape', () => {
  assert.strictEqual(parseQuotedXpropValue('"a\\nb\\101"'), 'a\nbA');
  assert.strictEqual(parseQuotedXpropValue('not quoted'), null);
});

test('parse nested sway tree', () => {
  const tree = {
    name: 'root',
    focused: false,
    nodes: [
      {
        name: 'workspace',
        focused: false,
        nodes: [
          { name: 'Firefox', app_id: 'firefox', pid: 111, focused: false },
          { name: 'Terminal', app_id: 'org.gnome.Console', pid: 222, focused: true },
        ],
        floating_nodes: [],
      },
    ],
    floating_nodes: [],
  };
  const info = parseSwayTree(JSON.stringify(tree));
  assert.deepStrictEqual(info, {
    title: 'Terminal',
    app: 'org.gnome.Console',
    pid: 222,
  });
});

test('parse i3 tree WM_CLASS fallback', () => {
  const tree = {
    focused: true,
    name: 'i3 window',
    pid: 33,
    window_properties: { class: 'XTerm', instance: 'xterm' },
  };
  assert.deepStrictEqual(parseSwayTree(JSON.stringify(tree)), {
    title: 'i3 window',
    app: 'XTerm',
    pid: 33,
  });
});

test('parse hyprland activewindow', () => {
  assert.deepStrictEqual(
    parseHyprlandWindow(
      JSON.stringify({ title: 'Editor', class: 'code', initialClass: 'code', pid: 9 })
    ),
    { title: 'Editor', app: 'code', pid: 9 }
  );
  assert.strictEqual(parseHyprlandWindow('{}'), null);
  assert.strictEqual(parseHyprlandWindow('Invalid command'), null);
});

test('parse wlrctl focused output', () => {
  assert.deepStrictEqual(parseWlrctlList('foot: hello: world\n'), {
    title: 'hello: world',
    app: 'foot',
    pid: 0,
  });
  assert.strictEqual(parseWlrctlList(''), null);
});

test('sanitize and truncate', () => {
  assert.strictEqual(sanitizeText('  a\n\tb  ', 10), 'a b');
  assert.strictEqual(sanitizeText('abcdefghij', 4), 'abcd');
  assert.strictEqual(sanitizeText(null, 4), '');
});

test('normalize server url', () => {
  assert.strictEqual(
    normalizeServerUrl('http://127.0.0.1:3000'),
    'http://127.0.0.1:3000/api/ingest'
  );
  assert.strictEqual(
    normalizeServerUrl('http://127.0.0.1:3000/'),
    'http://127.0.0.1:3000/api/ingest'
  );
  assert.strictEqual(
    normalizeServerUrl('https://example.com/api/ingest/'),
    'https://example.com/api/ingest'
  );
  assert.strictEqual(
    normalizeServerUrl('example.com:3000/api/ingest'),
    'http://example.com:3000/api/ingest'
  );
});

test('normalize config bounds', () => {
  const cfg = normalizeConfig({
    serverUrl: 'http://localhost:3000/api/ingest',
    machineId: ' test-box ',
    uploadKey: ' key ',
    intervalSec: 1,
    heartbeatSec: 1,
    maxTitleLen: 1,
  });
  assert.strictEqual(cfg.machineId, 'test-box');
  assert.strictEqual(cfg.uploadKey, 'key');
  assert.strictEqual(cfg.intervalSec, 5);
  assert.strictEqual(cfg.heartbeatSec, 10);
  assert.strictEqual(cfg.maxTitleLen, 10);
});

test('desktop exec quoting', () => {
  assert.strictEqual(quoteDesktopExecArg('/usr/bin/a b'), '"/usr/bin/a b"');
  assert.strictEqual(quoteDesktopExecArg('a"b$c'), '"a\\"b\\$c"');
});

console.log('\n' + passed + ' tests passed.');
