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

const scripts = env => [
  r('web/vendor/jszip.min.js'),
  `window.TL_ENV=${JSON.stringify(env)};`
  + `window.TL_LEX=${safe(json('lexicons/lexicons.json'))};`
  + `window.TL_VADER=${safe(json('lexicons/vader.json'))};`
  + `window.TL_SAMPLE=${safe(JSON.stringify(r('samples/sample_debate_android.txt')))};`,
  stripComments(coreSrc),
  r('web/src/app.js'),
].map(safe);

// The core script carries an id so app.js can read its own source for the Worker.
const CORE_INDEX = 2;
const tagFor = i => (i === CORE_INDEX ? '<script id="tl-core">' : '<script>');

const title = 'Threadlens — see how the argument actually went';
const desc = 'Free, private chat analysis in your browser. Drop in a WhatsApp export and see who asked and who asserted, who started it, where the heat rose, and how well each side argued. Works on relationship arguments, family group chats and work threads. Nothing is uploaded.';
const keywords = 'whatsapp chat analysis, argument analysis, who started the argument, relationship communication patterns, couples arguing over text, group chat analysis, conversation analysis, communication style, chat statistics, debate quality, private, offline';

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
${body}
${s.map((js, i) => `${tagFor(i)}${js}</script>`).join('\n')}
</body>
</html>
`;
  writeFileSync(join(root, 'dist/index.html'), html);
}

// Fragment for artifact-style hosts
{
  const s = scripts('artifact');
  const html = `<title>${title}</title>
<style>${css}</style>
${body}
${s.map((js, i) => `${tagFor(i)}${js}</script>`).join('\n')}
`;
  writeFileSync(join(root, 'dist/threadlens-artifact.html'), html);
}

// The page has to stay small enough to be worth downloading and running offline.
const BUDGET_KB = 400;
const kb = statSync(join(root, 'dist/index.html')).size / 1024;
console.log(`built dist/index.html (${kb.toFixed(0)} KB) and dist/threadlens-artifact.html`);
if (kb > BUDGET_KB) {
  console.error(`dist/index.html is ${kb.toFixed(0)} KB, over the ${BUDGET_KB} KB budget.`);
  process.exit(1);
}
