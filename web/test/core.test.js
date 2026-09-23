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

test('a transcript with no timestamps is read in order, and says so', () => {
  // Copying the message bubbles instead of exporting the chat gives you names and
  // text but no clock. That used to produce "none of them carry a timestamp".
  const t = ['Riya: Hiii', 'Sourav: Yooo', 'Riya: Kmn achis?', 'Sourav: cholche cholche',
    'Riya: the report says the backlog was 1,240 cases', 'Sourav: thats not true at all',
    'Riya: you people always do this', 'Sourav: the audit from October put it at 1,240'].join('\n');
  const p = core.parseChat(t);
  assert.strictEqual(p.undated, true);
  assert.strictEqual(p.messages.length, 8);
  assert.deepEqual([...new Set(p.messages.map(m => m.author))], ['Riya', 'Sourav']);
  // Order is preserved and strictly increasing, so everything downstream still works.
  for (let i = 1; i < p.messages.length; i++) {
    assert.ok(p.messages[i].date > p.messages[i - 1].date, 'the synthetic timeline must run forwards');
  }
  const res = A.analyse(p);
  assert.strictEqual(res.undated, true, 'the flag has to survive into the result, or the UI will draw a fake timeline');
});

test('a real export is never read as undated', () => {
  const p = core.parseChat(fs.readFileSync(path.join(root, 'samples/rigor_left_vs_right.txt'), 'utf8'));
  assert.strictEqual(p.undated, false);
  assert.ok(p.messages.length > 20);
});

test('prose with a colon in it is not mistaken for a speaker', () => {
  // The undated fallback only runs when nothing carries a timestamp, and even then a
  // "name" may not be a whole sentence.
  const p = core.parseChat('Here is the thing: it was never about the money.\nAnd another line.');
  assert.strictEqual(p.messages.length, 0);
});
