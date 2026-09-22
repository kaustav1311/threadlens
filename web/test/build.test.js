// The invariants in CLAUDE.md that are properties of the built page rather than
// of the scoring. These are the ones easiest to break by accident and hardest to
// notice, so they get asserted rather than trusted.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..', '..');
const DIST = path.join(root, 'dist/index.html');

test.before(() => { execFileSync(process.execPath, [path.join(root, 'scripts/build.mjs')], { cwd: root }); });

const dist = () => fs.readFileSync(DIST, 'utf8');
const srcFiles = () => ['web/src/core.js', 'web/src/app.js', 'web/src/body.html', 'web/src/style.css']
  .map(f => [f, fs.readFileSync(path.join(root, f), 'utf8')]);

/* ------------------------------------------- invariant 1: no network, ever */

test('the built page forbids every kind of network access', () => {
  const m = dist().match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/);
  assert.ok(m, 'no CSP in dist/index.html');
  const csp = m[1];
  for (const d of ["default-src 'none'", "connect-src 'none'", "font-src 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'none'"])
    assert.ok(csp.includes(d), `CSP is missing ${d}: ${csp}`);
  // the worker is built from a Blob of our own code; that is the only extra source allowed
  assert.ok(csp.includes('worker-src blob:'), 'worker-src blob: is required for the off-thread analysis');
  assert.ok(!/script-src[^;]*\*/.test(csp), 'script-src must stay hash-pinned');
});

test('no source file reaches for a CDN, a font or any remote host', () => {
  // Only real fetches matter; links a human clicks, and the page's own canonical
  // URL, are fine. This looks for code that would pull a resource at runtime.
  for (const [name, src] of srcFiles()) {
    assert.ok(!/\bfetch\s*\(/.test(src), `${name} calls fetch()`);
    assert.ok(!/XMLHttpRequest|navigator\.sendBeacon|EventSource|WebSocket/.test(src), `${name} opens a network connection`);
    assert.ok(!/@import\s+url\(\s*['"]?https?:/i.test(src), `${name} imports a remote stylesheet`);
    assert.ok(!/<link[^>]+href=["']https?:/i.test(src), `${name} links a remote resource`);
    assert.ok(!/<script[^>]+src=/i.test(src), `${name} loads an external script`);
    assert.ok(!/fonts\.(googleapis|gstatic)\.com/.test(src), `${name} loads a web font`);
  }
});

test('every script in the page is inline and hash-pinned', () => {
  const html = dist();
  assert.ok(!/<script[^>]+src=/i.test(html), 'dist must not reference an external script');
  const hashes = (html.match(/'sha256-[A-Za-z0-9+/=]+'/g) || []).length;
  // one of them is <script id="tl-core">, which the Worker reads its source from
  const inline = (html.match(/<script(?:\s[^>]*)?>/g) || []).length;
  assert.strictEqual(hashes, inline, `${inline} inline scripts but ${hashes} hashes`);
});

/* -------------------------- invariant 6: reduced motion turns everything off */

test('prefers-reduced-motion disables every animation and transition', () => {
  const css = fs.readFileSync(path.join(root, 'web/src/style.css'), 'utf8');
  const block = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.ok(block, 'no prefers-reduced-motion block');
  assert.match(block, /animation-duration:\s*\.?0*1?m?s\s*!important/, 'animations must be neutralised');
  assert.match(block, /transition-duration:\s*\.?0*1?m?s\s*!important/, 'transitions must be neutralised');
  assert.match(block, /animation-iteration-count:\s*1\s*!important/, 'looping animations must be stopped');
  // anything that animates must still reach its final state, not sit at zero
  assert.match(block, /scaleX\(var\(--w/, 'bars must land at their real width');
  assert.match(block, /stroke-dashoffset:\s*0/, 'chart lines must be drawn, not hidden');
});

test('the count-up animation is skipped when motion is reduced', () => {
  const app = fs.readFileSync(path.join(root, 'web/src/app.js'), 'utf8');
  assert.match(app, /prefers-reduced-motion: reduce/, 'app.js must consult the media query');
  const fn = app.slice(app.indexOf('function countUp'));
  const body = fn.slice(0, fn.indexOf('\n  }') + 4);
  assert.ok(/reduceMotion\(\)/.test(body), 'countUp must consult reduceMotion()');
  // It must write the finished value and return before reaching requestAnimationFrame.
  const guard = body.indexOf('reduceMotion()');
  const raf = body.indexOf('requestAnimationFrame');
  assert.ok(guard > -1 && raf > guard, 'the reduced-motion guard must come before any animation');
  assert.ok(/reduceMotion\(\)[\s\S]{0,120}?return;/.test(body),
    'countUp must bail out of the guard, not fall through into the animation');
  assert.ok(/node\.style\.minWidth/.test(body),
    'countUp must reserve the final width so the label below it does not jitter');
});

/* ------------------------------------------------------------ page budget */

test('the page stays small enough to download and run offline', () => {
  // Read the cap from the build rather than repeating it, so the two can never
  // disagree about what the budget is.
  const build = fs.readFileSync(path.join(root, 'scripts/build.mjs'), 'utf8');
  const cap = Number((build.match(/BUDGET_KB\s*=\s*(\d+)/) || [])[1]);
  assert.ok(cap > 0, 'scripts/build.mjs must declare a BUDGET_KB');
  const kb = fs.statSync(DIST).size / 1024;
  assert.ok(kb <= cap, `dist/index.html is ${kb.toFixed(0)} KB, over the ${cap} KB budget`);
  // And the headroom is worth knowing about: if the page ever gets close to the cap
  // again, the fix is to pack data, not to raise the number a second time.
  assert.ok(kb < cap * 0.95 || process.env.CI, `dist/index.html is at ${Math.round(kb / cap * 100)}% of the budget`);
});

test('the page declares the Rigor lens and the relationship keywords it should be found by', () => {
  const html = dist();
  assert.match(html, /<meta name="description" content="[^"]{80,}"/);
  for (const kw of ['relationship', 'group chat', 'whatsapp chat analysis'])
    assert.ok(html.toLowerCase().includes(kw), `missing keyword: ${kw}`);
  assert.match(html, /data-lens="rigor"/);
});

/* ------------------------------------------ the worker copy of core.js */

test('the worker source is valid JS and still exports the core', () => {
  // The worker is built from the page's own <script id="tl-core">, and its
  // comments are stripped to fit the budget. A bad strip would leave the worker
  // broken and the app would fall back to the main thread -- exactly the kind of
  // failure nobody notices.
  const html = dist();
  const m = html.match(/<script id="tl-core">([\s\S]*?)<\/script>/);
  assert.ok(m, 'no <script id="tl-core"> in dist -- the worker has nothing to read');
  const src = m[1];
  assert.ok(!html.includes('window.TL_CORE_SRC'), 'core.js must not also be embedded as a string');

  assert.ok(!/^\s*\/\//m.test(src), 'whole-line comments should have been stripped');
  const fake = {};
  new Function('self', src)(fake);
  assert.ok(fake.ThreadlensCore, 'the stripped source did not define ThreadlensCore');
  for (const fn of ['parseChat', 'createAnalyzer', 'findings', 'toMarkdown'])
    assert.strictEqual(typeof fake.ThreadlensCore[fn], 'function', `worker core is missing ${fn}`);

  // and it must still actually parse a chat
  const p = fake.ThreadlensCore.parseChat('01/02/2026, 10:01 - A: hello there friend\n01/02/2026, 10:02 - B: hi');
  assert.strictEqual(p.messages.length, 2);
});

test('the packed VADER lexicon in the page round-trips to the source file exactly', () => {
  // VADER is inlined packed to keep the page inside its size budget. A packing bug
  // would shift every sentiment score by a silent, plausible-looking amount.
  const m = dist().match(/window\.TL_VADER=("(?:[^"\\]|\\.)*")/);
  assert.ok(m, 'the page must carry a packed VADER string');
  const unpacked = require('../src/core.js').unpackVader(JSON.parse(m[1]));
  const source = JSON.parse(fs.readFileSync(path.join(root, 'lexicons/vader.json'), 'utf8'));
  const keys = Object.keys(source);
  assert.strictEqual(Object.keys(unpacked).length, keys.length, 'entries were lost in packing');
  for (const k of keys) {
    assert.ok(Math.abs(unpacked[k] - source[k]) < 1e-9, `"${k}" unpacked to ${unpacked[k]}, expected ${source[k]}`);
  }
});

test('the headline carousel stops rotating when motion is reduced', () => {
  // Invariant 6: with reduced motion nothing may animate on its own, and every
  // animated element must still land on its final state. For a carousel that means
  // one question, fully visible and untransformed -- not a blank or half-faded one.
  const css = fs.readFileSync(path.join(root, 'web/src/style.css'), 'utf8');
  const block = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.match(block, /\.rotator[^}]*\.is-on\s*\{[^}]*opacity:\s*1/, 'the visible slide must be fully opaque');
  assert.match(block, /\.rotator[^}]*\.is-on\s*\{[^}]*transform:\s*none/, 'the visible slide must not sit mid-slide');

  const app = fs.readFileSync(path.join(root, 'web/src/app.js'), 'utf8');
  const fn = app.slice(app.indexOf('function heroCarousel'));
  const body = fn.slice(0, fn.indexOf('\n  }\n  heroCarousel'));
  assert.ok(/reduceMotion\(\)/.test(body), 'the carousel must consult reduceMotion()');
  // The auto-advance timer must be guarded, not merely the transition.
  const run = body.slice(body.indexOf('const run = '));
  const guard = run.indexOf('reduceMotion()');
  const timer = run.indexOf('setTimeout');
  assert.ok(guard > -1 && timer > guard, 'the reduced-motion guard must come before the advance timer');
  assert.ok(/reduceMotion\(\)[^;]{0,40}\)\s*return;/.test(run), 'it must return before scheduling anything');
});
