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
  const inline = (html.match(/<script>/g) || []).length;
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
  assert.ok(/reduceMotion\(\)[\s\S]{0,140}?node\.textContent = fmt\(to\);[\s\S]{0,40}?return;/.test(body),
    'countUp must set the final value and bail out before animating');
});

/* ------------------------------------------------------------ page budget */

test('the page stays small enough to download and run offline', () => {
  const kb = fs.statSync(DIST).size / 1024;
  assert.ok(kb <= 400, `dist/index.html is ${kb.toFixed(0)} KB, over the 400 KB budget`);
});

test('the page declares the Rigor lens and the relationship keywords it should be found by', () => {
  const html = dist();
  assert.match(html, /<meta name="description" content="[^"]{80,}"/);
  for (const kw of ['relationship', 'group chat', 'whatsapp chat analysis'])
    assert.ok(html.toLowerCase().includes(kw), `missing keyword: ${kw}`);
  assert.match(html, /data-lens="rigor"/);
});
