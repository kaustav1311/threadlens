// The eval gold set: does it still line up with the fixture it labels?
// Run: node --test "web/test/*.test.js"
//
// `make eval` is only meaningful if every gold label is attached to a unit that
// still exists, with the text it was judged on. Edit the fixture and forget the
// labels, and the harness quietly scores a smaller set — the numbers stay
// plausible and stop meaning anything. This test makes that an error instead.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const core = require('../src/core.js');

const root = path.join(__dirname, '..', '..');
const gold = JSON.parse(fs.readFileSync(path.join(root, 'samples/labels_banglish_mixed.json'), 'utf8'));
const sample = fs.readFileSync(path.join(root, gold.sample), 'utf8');

/**
 * scripts/items.mjs is ESM and this suite is CommonJS. Rather than duplicate the
 * unit-building here — which is precisely the drift this file exists to catch —
 * shell out and read back the ids it produces.
 */
function unitsFromScript() {
  const src = 'import {core,buildItems} from "./scripts/items.mjs";'
    + 'import {readFileSync} from "node:fs";'
    + 'const i=buildItems(core.parseChat(readFileSync(process.argv[1],"utf8")).messages);'
    + 'process.stdout.write(JSON.stringify({claims:i.claims.map(u=>[u.id,u.text]),'
    + 'questions:i.questions.map(u=>[u.id,u.text]),episodes:i.episodes.map(e=>e.id)}));';
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', src, path.join(root, gold.sample)],
    { cwd: root, encoding: 'utf8' });
  return JSON.parse(out);
}

test('every gold label still matches a unit of the fixture, with the same text', () => {
  const units = unitsFromScript();
  for (const task of ['claims', 'questions']) {
    const byId = new Map(units[task]);
    assert.equal(gold[task].length, units[task].length,
      `${task}: gold set has ${gold[task].length} labels but the fixture yields ${units[task].length} units — regenerate the gold set`);
    for (const g of gold[task]) {
      assert.ok(byId.has(g.id), `${task}: gold label ${g.id} has no matching unit`);
      assert.equal(byId.get(g.id), g.text, `${task}: the text of unit ${g.id} changed under its label`);
    }
  }
  assert.deepEqual(gold.episodes.map(e => e.id), units.episodes,
    'episode boundaries moved: the fixture and the gold set disagree about where conversations split');
});

test('the gold set labels every unit, with values the harness knows', () => {
  const values = {
    claims: ['yes', 'no'],
    questions: ['phatic', 'rhetorical', 'substantive'],
    episodes: ['casual', 'logistics', 'argument', 'work'],
  };
  for (const task of Object.keys(values)) {
    for (const g of gold[task]) {
      assert.ok(values[task].includes(g.label), `${task}: ${g.id} has unknown label ${JSON.stringify(g.label)}`);
    }
  }
});

test('the fixture keeps the shape it was built to reproduce', () => {
  // A fixture that drifts into tidy English sentences would quietly stop testing the
  // thing it exists for. These are the properties the real chat had.
  const parsed = core.parseChat(sample);
  const msgs = parsed.messages.filter(m => m.kind === 'text');
  const words = msgs.map(m => (m.text.toLowerCase().match(/[a-z0-9']+/g) || []).length).sort((a, b) => a - b);
  const median = words[Math.floor(words.length / 2)];
  assert.ok(median <= 6, `median message is ${median} words; chat messages are short and the fixture must stay so`);

  const withQ = msgs.filter(m => m.text.includes('?')).length / msgs.length;
  assert.ok(withQ > 0.05 && withQ < 0.2, `${(withQ * 100).toFixed(1)}% of messages ask something; expected roughly 10%`);

  // Romanised Bengali has to survive in the fixture, because it is the whole point of it.
  const bn = /\b(na|ami|tui|tumi|ache|achis|kore|theke|eta|ektu|kothay|kmn|bhalo|jani|jodi|tahole|toh|nei|hobe|hoyeche|cholche|bas|dekhi|bol)\b/i;
  const coded = msgs.filter(m => bn.test(m.text)).length;
  assert.ok(coded >= 25, `only ${coded} messages carry romanised Bengali; the fixture exists to exercise code-switching`);

  // Two arguments buried in small talk: that is the case for scoping Rigor per episode.
  const args = gold.episodes.filter(e => e.label === 'argument');
  assert.equal(args.length, 2, 'the fixture should hold exactly two argument episodes');
  const inArgs = args.reduce((n, e) => n + (e.to - e.from + 1), 0);
  assert.ok(inArgs / parsed.messages.length > 0.3,
    'the arguments should hold a large share of the messages while being a small share of the episodes');
});
