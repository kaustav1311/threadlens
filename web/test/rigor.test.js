// Rigor mode: neutrality, claim extraction and score bounds.
// Run: node --test "web/test/*.test.js"
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../src/core.js');

const root = path.join(__dirname, '..', '..');
const lexRaw = fs.readFileSync(path.join(root, 'lexicons/lexicons.json'), 'utf8');
const lex = JSON.parse(lexRaw);
const vader = JSON.parse(fs.readFileSync(path.join(root, 'lexicons/vader.json'), 'utf8'));
const A = core.createAnalyzer(lex, vader);

const analyse = name => A.analyse(core.parseChat(fs.readFileSync(path.join(root, 'samples', name), 'utf8')));

/* ------------------------------------------------------------- neutrality */

test('political_label stays balanced between left-coded and right-coded labels', () => {
  const pl = lex.political_label;
  assert.ok(pl.left_coded && pl.right_coded && pl.neutral, 'political_label must be tagged by who uses the label');
  const L = pl.left_coded.length, R = pl.right_coded.length;
  const skew = Math.abs(L - R) / Math.max(L, R);
  assert.ok(skew <= 0.2, `left_coded=${L} right_coded=${R} skew=${(skew * 100).toFixed(1)}% exceeds 20%`);
  // no entry may appear under two tags, which would double-count it
  const all = [...pl.left_coded, ...pl.right_coded, ...pl.neutral];
  assert.strictEqual(new Set(all).size, all.length, 'duplicate entry across political_label tags');
});

test('no scoring list names a party, a leader or a policy topic', () => {
  // Invariant 3: the lists may describe conduct, never a political position.
  const banned = /\b(congress|bjp|labour|tory|tories|republican|democrat|modi|trump|biden|gandhi|maga|brexit|abortion|vaccine)\b/i;
  const walk = (v, where) => {
    if (typeof v === 'string') assert.ok(!banned.test(v), `banned token in ${where}: ${v}`);
    else if (Array.isArray(v)) v.forEach(x => walk(x, where));
    else if (v && typeof v === 'object') for (const k of Object.keys(v)) walk(v[k], where + '.' + k);
  };
  for (const k of Object.keys(lex)) if (k !== '_about') walk(lex[k], k);
});

test('mirrored samples swap their rigor scores', () => {
  // Same argument, opposite sides. If scoring had any political lean the scores
  // would not swap -- this is the regression test for invariant 3.
  const a = analyse('rigor_left_vs_right.txt').rigor.people;
  const b = analyse('rigor_right_vs_left.txt').rigor.people;
  assert.ok(a.Priya.score != null && a.Arjun.score != null);
  assert.ok(Math.abs(a.Priya.score - b.Arjun.score) <= 3,
    `Priya ${a.Priya.score.toFixed(1)} vs mirrored Arjun ${b.Arjun.score.toFixed(1)}`);
  assert.ok(Math.abs(a.Arjun.score - b.Priya.score) <= 3,
    `Arjun ${a.Arjun.score.toFixed(1)} vs mirrored Priya ${b.Priya.score.toFixed(1)}`);
  // and the person who argued better must actually come out ahead
  assert.ok(a.Priya.score > a.Arjun.score + 10, 'the sourced, civil speaker should score clearly higher');
  for (const k of Object.keys(core.RIGOR_WEIGHTS)) {
    const x = a.Priya.components[k], y = b.Arjun.components[k];
    if (x == null || y == null) continue;
    assert.ok(Math.abs(x - y) <= 0.05, `component ${k} did not mirror: ${x} vs ${y}`);
  }
});

/* ----------------------------------------------------------------- scoring */

test('rigor components stay in range and every one is explained', () => {
  const res = analyse('rigor_left_vs_right.txt');
  for (const name of Object.keys(res.rigor.people)) {
    const p = res.rigor.people[name];
    assert.ok(p.score >= 0 && p.score <= 100, `${name} score out of range: ${p.score}`);
    for (const k of Object.keys(core.RIGOR_WEIGHTS)) {
      const v = p.components[k];
      assert.ok(v === null || (v >= 0 && v <= 1), `${name}.${k} out of range: ${v}`);
      assert.ok(core.RIGOR_LABELS[k] && core.RIGOR_HOW[k], `component ${k} has no label or explanation`);
    }
  }
  assert.strictEqual(Object.values(core.RIGOR_WEIGHTS).reduce((a, b) => a + b, 0), 100);
});

test('claims exclude questions, opinions, offers and one-liners', () => {
  const res = analyse('rigor_left_vs_right.txt');
  for (const c of res.rigor.ledger) {
    assert.ok(!c.text.includes('?'), `question in the claim ledger: ${c.text}`);
    assert.ok(!/^(if |let's |happy to |i think|i feel|can you)/i.test(c.text), `non-claim in the ledger: ${c.text}`);
    assert.ok(c.text.split(/\s+/).length >= 5, `too short to be a claim: ${c.text}`);
    assert.ok(['sourced', 'specific', 'vague'].includes(c.status));
  }
  assert.ok(res.rigor.ledger.length >= 5, 'expected the sample to yield claims');
});

test('a sourced claim is recognised and a bare assertion is not', () => {
  const res = analyse('rigor_left_vs_right.txt');
  const sourced = res.rigor.ledger.filter(c => c.status === 'sourced');
  assert.ok(sourced.some(c => /section 4|page 31/i.test(c.text)), 'named-document claim should count as sourced');
  assert.ok(res.rigor.ledger.some(c => c.status === 'vague' && /never done anything right/i.test(c.text)),
    'an unsupported sweeping assertion should be vague');
});

test('a month prefix inside an ordinary word is not a date', () => {
  // "market" starts with "mar", "maybe" with "may" -- both used to count as sourcing.
  const plain = 'A: the market was busy and maybe it stays busy for everyone there';
  const dated = 'A: the report was published on 12 March 2026 and it says the opposite';
  const mk = body => '01/02/2026, 10:0' + (mk.n = (mk.n || 0) + 1) + ' - ' + body;
  const res = A.analyse(core.parseChat([mk(plain), mk(dated)].join('\n')));
  const byText = Object.fromEntries(res.rigor.ledger.map(c => [c.text.slice(0, 12), c]));
  const marketClaim = res.rigor.ledger.find(c => /market/.test(c.text));
  const datedClaim = res.rigor.ledger.find(c => /March/.test(c.text));
  assert.ok(marketClaim && !marketClaim.checkable, 'the word "market" must not read as a date');
  assert.ok(datedClaim && datedClaim.checkable, 'a real date must read as checkable');
  assert.ok(byText);
});

test('rigor lens produces findings and a markdown report', () => {
  const res = analyse('rigor_left_vs_right.txt');
  const f = core.findings(res, 'rigor');
  assert.ok(f.length >= 2);
  assert.ok(f.every(x => x.text), 'every finding needs a full sentence');
  assert.ok(f.some(x => /not whether either position is correct|never which side is right/.test(x.text)),
    'the rigor lens must state that it does not judge the position');
  const md = core.toMarkdown(res, 'rigor');
  assert.match(md, /## Rigor scores/);
  assert.match(md, /## Claim ledger/);
});

test('rigor runs on every sample without throwing', () => {
  for (const f of fs.readdirSync(path.join(root, 'samples')).filter(x => x.endsWith('.txt'))) {
    const res = analyse(f);
    assert.ok(res.rigor && res.rigor.people, f);
    assert.ok(res.rigor.topicTerms.length > 0, f);
  }
});

/* ------------------------------------------------- rigor v2: what changed */

const mk = (rows) => rows.map(([day, hh, mm, who, text]) =>
  `${String(day).padStart(2, '0')}/06/2026, ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')} - ${who}: ${text}`).join('\n');

test('conduct does not punish brevity: it counts messages, not words per 100', () => {
  // The bug this replaces: per-100-words made a terse speaker with one insult
  // look worse than a verbose speaker with five. Both people here are hostile in
  // exactly one message of ten; one writes short messages and one writes long
  // ones. Their Conduct must be the same.
  const padding = 'the committee report from March 2026 set out the position at some length and in detail ';
  const terse = [], windy = [];
  for (let i = 0; i < 10; i++) {
    terse.push([1 + i, 9, i, 'Terse', i === 0 ? 'you are an idiot' : 'the report says it rose']);
    windy.push([1 + i, 9, i, 'Windy', (i === 0 ? 'you are an idiot ' : '') + padding + 'and the report says it rose']);
  }
  const a = A.analyse(core.parseChat(mk(terse))).rigor.people.Terse;
  const b = A.analyse(core.parseChat(mk(windy))).rigor.people.Windy;
  assert.ok(Math.abs(a.components.conduct - b.components.conduct) < 1e-9,
    `conduct differed by verbosity alone: terse ${a.components.conduct}, windy ${b.components.conduct}`);
  assert.strictEqual(a.hostileMessages, 1);
  assert.strictEqual(b.hostileMessages, 1);
});

test('a chat is split into episodes, and drift is measured against each one', () => {
  // Two conversations days apart about completely different things. Measured
  // against a single global opening, the second would read as pure "drift";
  // measured against its own opening it should not.
  const rows = [];
  for (let i = 0; i < 6; i++) rows.push([1, 9, i, i % 2 ? 'B' : 'A', 'the rent cap report said the waiting list rose in January']);
  for (let i = 0; i < 6; i++) rows.push([9, 9, i, i % 2 ? 'B' : 'A', 'the cricket selection panel dropped the opening batsman yesterday']);
  const res = A.analyse(core.parseChat(mk(rows)));
  assert.ok(res.rigor.episodes >= 2, `expected at least 2 episodes, got ${res.rigor.episodes}`);
  assert.ok(res.rigor.episodeTopics.length >= 2);
  // the two episodes must have genuinely different topics
  const [e1, e2] = res.rigor.episodeTopics;
  assert.strictEqual(e1.filter(t => e2.includes(t)).length, 0, 'episode topics should not overlap here');
  // and the second conversation must not be scored as maximal drift
  const late = res.rigor.drift.filter(d => new Date(d.date).getDate() === 9);
  assert.ok(late.length && late.every(d => d.drift < 0.95),
    'a later conversation on its own topic should not read as total drift');
});

test('rigor reports how applicable it is, and admits when it is not', () => {
  const chatty = [];
  for (let i = 0; i < 30; i++) chatty.push([1 + (i % 20), 9, i % 60, i % 2 ? 'B' : 'A', 'haha ok sure see you then']);
  const casual = A.analyse(core.parseChat(mk(chatty))).rigor.applicability;
  assert.strictEqual(casual.claims, 0);
  assert.ok(casual.weak, 'a chat with no factual claims must flag Rigor as a weak fit');

  const argued = analyse('rigor_left_vs_right.txt').rigor.applicability;
  assert.ok(argued.claims > 10, 'the argument sample should yield claims');
  assert.ok(!argued.weak, `the argument sample should be a good fit, got ${argued.fit.toFixed(2)}`);
});

test('a clip narrows the conversation before anything is scored', () => {
  const t = fs.readFileSync(path.join(root, 'samples/rigor_left_vs_right.txt'), 'utf8');
  const all = core.parseChat(t);
  const firstDay = core.parseChat(t, { from: '2026-04-04', to: '2026-04-04' });
  const secondDay = core.parseChat(t, { from: '2026-04-05' });
  assert.ok(firstDay.messages.length > 0 && secondDay.messages.length > 0);
  assert.strictEqual(firstDay.messages.length + secondDay.messages.length, all.messages.length);
  // `to` as a bare date means the whole of that day
  assert.ok(firstDay.messages.every(m => m.date.getDate() === 4));
  assert.ok(secondDay.messages.every(m => m.date.getDate() === 5));
  // and the clip must reach the scoring, not just the message list
  const clipped = A.analyse(secondDay);
  assert.ok(clipped.totals.messages < A.analyse(all).totals.messages);
  assert.strictEqual(all.clipped, 0);
  assert.ok(firstDay.clipped > 0);
});
