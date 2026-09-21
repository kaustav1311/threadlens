// Run: node --test web/test
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../src/core.js');

const root = path.join(__dirname, '..', '..');
const lex = JSON.parse(fs.readFileSync(path.join(root, 'lexicons/lexicons.json'), 'utf8'));
const vader = JSON.parse(fs.readFileSync(path.join(root, 'lexicons/vader.json'), 'utf8'));
const A = core.createAnalyzer(lex, vader);

test('parses Android 24h export and skips system lines', () => {
  const t = fs.readFileSync(path.join(root, 'samples/sample_debate_android.txt'), 'utf8');
  const p = core.parseChat(t);
  assert.strictEqual(p.dateOrder, 'DMY');
  assert.strictEqual(p.systemLines, 1);
  assert.strictEqual(new Set(p.messages.map(m => m.author)).size, 2);
  assert.ok(p.messages.length >= 20);
});

test('parses iOS 12h export with invisible marks and multi-line messages', () => {
  const t = '\u200e[3/14/26, 9:05:11\u202fPM] Sam: first line\nsecond line\n[3/14/26, 9:06:00\u202fPM] Kai: \u200eimage omitted\n[3/14/26, 10:00:00\u202fPM] Kai: ok <This message was edited>';
  const p = core.parseChat(t);
  assert.strictEqual(p.dateOrder, 'MDY');
  assert.strictEqual(p.messages.length, 3);
  assert.strictEqual(p.messages[0].text, 'first line\nsecond line');
  assert.strictEqual(p.messages[0].date.getHours(), 21);
  assert.strictEqual(p.messages[1].kind, 'media');
  assert.ok(p.messages[2].edited);
});

test('US Android format with AM/PM', () => {
  const p = core.parseChat('12/31/25, 11:59 PM - A: hi\n1/1/26, 12:01 AM - B: happy new year');
  assert.strictEqual(p.messages.length, 2);
  assert.strictEqual(p.messages[1].date.getFullYear(), 2026);
  assert.strictEqual(p.messages[1].date.getHours(), 0);
});

test('analysis produces symmetric stats, findings and markdown', () => {
  const t = fs.readFileSync(path.join(root, 'samples/sample_debate_android.txt'), 'utf8');
  const res = A.analyse(core.parseChat(t));
  const ravi = res.stats.find(s => s.name === 'Ravi'), asha = res.stats.find(s => s.name === 'Asha');
  assert.ok(ravi.absolutist > asha.absolutist);
  assert.ok(asha.questionRate > ravi.questionRate);
  assert.ok(ravi.rhetoric.exit_or_concession >= 1);
  assert.ok(ravi.reentries.length >= 1, 'detects exit then long return');
  assert.ok(ravi.heatMean > asha.heatMean);
  for (const lens of Object.keys(core.LENSES)) {
    const f = core.findings(res, lens);
    assert.ok(Array.isArray(f));
    assert.match(core.toMarkdown(res, lens), /Threadlens report/);
  }
});

test('anonymise replaces names', () => {
  const t = fs.readFileSync(path.join(root, 'samples/sample_debate_android.txt'), 'utf8');
  const res = A.analyse(core.parseChat(t), { anonymise: true });
  assert.deepStrictEqual(res.people.sort(), ['Person A', 'Person B']);
});

test('empty input throws a readable error', () => {
  assert.throws(() => A.analyse(core.parseChat('hello world')), /No messages found/);
});
