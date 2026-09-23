// Build Threadlens into single self-contained HTML files. No dependencies.
//   node scripts/build.mjs
// dist/index.html              full page with a strict CSP (connect-src 'none'), for GitHub Pages or offline use
// dist/threadlens-artifact.html  body-only fragment for hosts that supply their own <html>/<head> (e.g. a Claude artifact)
import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const r = p => readFileSync(join(root, p), 'utf8');
const safe = s => s.replace(/<\/(script)/gi, '<\\/$1');

// The stylesheet is heavily commented on purpose -- the reasoning behind a token
// belongs next to it. The browser does not need any of that, so it is stripped
// from the inlined copy only. CSS has no comment-like syntax inside its values,
// so a plain block-comment strip is safe here in a way it would not be in JS.
const css = r('web/src/style.css')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\n/gm, '')
  .trim();
const body = r('web/src/body.html');
const coreSrc = r('web/src/core.js');

// The Worker is built from a Blob of core.js, because there is no network to
// fetch a script over -- that is the only reason the CSP allows worker-src blob:,
// and it is why connect-src can stay 'none'. The source is NOT embedded twice:
// app.js reads it back off the <script id="tl-core"> tag that is already in the
// document. Comments are stripped to keep the page inside its budget; the
// annotated source is in the repo and linked from the footer. Whole-line
// comments only: anything cleverer would eat the `https?:\/\/` in core.js's regexes.
const stripComments = s => s
  .replace(/^[ 	]*\/\*[\s\S]*?\*\/[ 	]*$/gm, '')
  .replace(/^[ 	]*\/\/.*$/gm, '')
  .replace(/\n{2,}/g, '\n')
  .trim();

// The JSON in lexicons/ is kept pretty-printed so diffs are reviewable; inline it minified.
const json = p => JSON.stringify(JSON.parse(r(p)));

/**
 * VADER as JSON is 7,506 entries and 119 KB — a third of the page budget spent on
 * quotes, colons and commas. Packed as `word score~word score` with the score in
 * tenths it is 96 KB. Lossless: VADER is specified to one decimal place, and the
 * build asserts that below rather than trusting it. core.js unpacks it.
 *
 * The separator is "~": the lexicon includes emoticons, so most ASCII punctuation
 * appears inside a key. The assertion below is what caught "(-:|>*".
 */
const VADER_SEP = '~';

function packVader(p) {
  const v = JSON.parse(r(p));
  const keys = Object.keys(v);
  for (const k of keys) {
    if (Math.abs(v[k] - Math.round(v[k] * 10) / 10) > 1e-9) throw new Error(`vader value for "${k}" needs more than one decimal: ${v[k]}`);
    if (k.includes(VADER_SEP)) throw new Error(`vader key contains the packing separator: ${k}`);
  }
  return JSON.stringify(keys.map(k => k + ' ' + Math.round(v[k] * 10)).join(VADER_SEP));
}

const publicBody = body.replace(/<!--BUILD:[A-Z-]+-->/g, '');

const scripts = env => [
  r('web/vendor/jszip.min.js'),
  `window.TL_ENV=${JSON.stringify(env)};`
  + `window.TL_LEX=${safe(json('lexicons/lexicons.json'))};`
  + `window.TL_VADER=${safe(packVader('lexicons/vader.json'))};`
  + `window.TL_SAMPLE=${safe(JSON.stringify(r('samples/sample_debate_android.txt')))};`,
  stripComments(coreSrc),
  r('web/src/app.js'),
].map(safe);

// The core script carries an id so app.js can read its own source for the Worker.
const CORE_INDEX = 2;
const tagFor = i => (i === CORE_INDEX ? '<script id="tl-core">' : '<script>');

const title = 'Threadlens — the compatibility test for people who argue';
const desc = 'The compatibility test for people who argue. Drop in a chat from WhatsApp, Instagram, Messenger, X, Discord or Reddit and see who started it, who brings receipts, who actually answers, and whether you are even arguing about the same thing. Same ruler for both sides, no verdict, nothing uploaded.';
const keywords = 'chat compatibility test, whatsapp chat analysis, argument analysis, who started the argument, relationship communication patterns, couples arguing over text, group chat analysis, conversation analysis, communication style, chat statistics, debate quality, code switching, hinglish, banglish, private, offline';

mkdirSync(join(root, 'dist'), { recursive: true });

// Full page with hashed-script CSP
{
  const s = scripts('web');
  const hashes = s.map(js => `'sha256-${createHash('sha256').update(js, 'utf8').digest('base64')}'`).join(' ');
  const csp = `default-src 'none'; script-src ${hashes}; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; font-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'; worker-src blob:`;
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="referrer" content="no-referrer">
<meta name="description" content="${desc}">
<meta name="keywords" content="${keywords}">
<meta name="color-scheme" content="light dark">
<meta property="og:type" content="website">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${desc}">
<meta property="og:url" content="https://kaustav1311.github.io/threadlens/">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${title}">
<meta name="twitter:description" content="${desc}">
<link rel="canonical" href="https://kaustav1311.github.io/threadlens/">
<title>${title}</title>
<style>${css}</style>
</head>
<body>
${publicBody}
${s.map((js, i) => `${tagFor(i)}${js}</script>`).join('\n')}
</body>
</html>
`;
  writeFileSync(join(root, 'dist/index.html'), html);
}

/* ---------------------------------------------------------- local-model build
 * A SEPARATE page that is allowed to talk to a model running on your own machine,
 * and nothing else. It exists because the sealed page cannot do the one judgement
 * a word list cannot make — assertion versus strongly-worded opinion — and some
 * people would rather run a model than accept that limit.
 *
 * It is deliberately a different file with a different name:
 *   - dist/index.html keeps `connect-src 'none'` and is the only thing deployed.
 *   - .github/workflows/pages.yml publishes index.html, never this.
 *   - .gitignore excludes it, so it cannot be committed by accident.
 *   - build.test.js asserts the sealed page never gains a connect-src.
 * The privacy copy changes in the same build, because a page that can reach the
 * network must not carry a page's claim that it cannot.
 */
const LOCAL_ORIGIN = 'http://127.0.0.1:11434';
const LOCAL_BANNER = `<div class="wrap local-banner" role="note">`
  + `<b>Local-model build.</b> This copy of the page is allowed to talk to a model running on this machine `
  + `at <span class="mono">${LOCAL_ORIGIN}</span>, and to nothing else. It is not the version published at `
  + `the public address, which cannot open a network connection at all. Do not host this file anywhere.`
  + `</div>`;
const LOCAL_CLAIM = `<p>Not this build. The published page ships a Content-Security-Policy of `
  + `<span class="mono">connect-src 'none'</span> and cannot open a connection at all — but you are reading `
  + `the <b>local-model build</b>, whose policy allows exactly one destination: `
  + `<span class="mono">${LOCAL_ORIGIN}</span>, an ollama server on this machine. Everything else is still `
  + `refused, nothing is uploaded, and the analysis still happens in this tab. If you want the sealed `
  + `guarantee, use <span class="mono">dist/index.html</span> instead.</p>`;

{
  // Markers must exist, or the local build would silently ship the sealed page's
  // privacy claim while being able to reach the network.
  for (const marker of ['<!--BUILD:LOCAL-BANNER-->', '<!--BUILD:NETWORK-CLAIM-->']) {
    if (!body.includes(marker)) throw new Error(`web/src/body.html is missing ${marker}`);
  }
  const localBody = body
    .replace('<!--BUILD:LOCAL-BANNER-->', LOCAL_BANNER)
    .replace(/<!--BUILD:NETWORK-CLAIM-->\s*<p>[\s\S]*?<\/p>/, LOCAL_CLAIM);
  const s = scripts('local');
  const hashes = s.map(js => `'sha256-${createHash('sha256').update(js, 'utf8').digest('base64')}'`).join(' ');
  const csp = `default-src 'none'; script-src ${hashes}; style-src 'unsafe-inline'; img-src data: blob:; connect-src ${LOCAL_ORIGIN}; font-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'; worker-src blob:`;
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="light dark">
<title>${title} — local-model build</title>
<style>${css}
.local-banner { border: var(--rule) solid var(--warn); background: var(--warn-soft); color: var(--ink); padding: var(--pad); margin-block: var(--space-5); font-size: var(--text-sm); }
</style>
</head>
<body>
${localBody}
${s.map((js, i) => `${tagFor(i)}${js}</script>`).join('\n')}
</body>
</html>
`;
  writeFileSync(join(root, 'dist/index-local.html'), html);
}

// Fragment for artifact-style hosts
{
  const s = scripts('artifact');
  const html = `<title>${title}</title>
<style>${css}</style>
${publicBody}
${s.map((js, i) => `${tagFor(i)}${js}</script>`).join('\n')}
`;
  writeFileSync(join(root, 'dist/threadlens-artifact.html'), html);
}

// The page has to stay small enough to be worth downloading and running offline.
// It is one file with no network of any kind behind it, so everything it will ever
// need — the code, the word lists, the sentiment lexicon, the zip reader — ships in
// that number. The cap is a guard against drifting into a multi-megabyte page by
// accident, not a target: at the time of writing the build comes in around 370 KB.
// Before raising this again, check whether the growth is data (pack it, as VADER is
// packed above) or code (it probably needs deleting).
const BUDGET_KB = 600;
const kb = statSync(join(root, 'dist/index.html')).size / 1024;
console.log(`built dist/index.html (${kb.toFixed(0)} KB), dist/threadlens-artifact.html and dist/index-local.html`);
if (kb > BUDGET_KB) {
  console.error(`dist/index.html is ${kb.toFixed(0)} KB, over the ${BUDGET_KB} KB budget.`);
  process.exit(1);
}
