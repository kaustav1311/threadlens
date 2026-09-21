// Build Threadlens into single self-contained HTML files. No dependencies.
//   node scripts/build.mjs
// dist/index.html              full page with a strict CSP (connect-src 'none'), for GitHub Pages or offline use
// dist/threadlens-artifact.html  body-only fragment for hosts that supply their own <html>/<head> (e.g. a Claude artifact)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const r = p => readFileSync(join(root, p), 'utf8');
const safe = s => s.replace(/<\/(script)/gi, '<\\/$1');

const css = r('web/src/style.css');
const body = r('web/src/body.html');
const scripts = env => [
  r('web/vendor/jszip.min.js'),
  `window.TL_ENV=${JSON.stringify(env)};window.TL_LEX=${safe(r('lexicons/lexicons.json'))};window.TL_VADER=${safe(r('lexicons/vader.json'))};window.TL_SAMPLE=${safe(JSON.stringify(r('samples/sample_debate_android.txt')))};`,
  r('web/src/core.js'),
  r('web/src/app.js'),
].map(safe);

const title = 'Threadlens';
const desc = 'Private, in-browser analysis of WhatsApp chat exports. Nothing is uploaded.';

mkdirSync(join(root, 'dist'), { recursive: true });

// Full page with hashed-script CSP
{
  const s = scripts('web');
  const hashes = s.map(js => `'sha256-${createHash('sha256').update(js, 'utf8').digest('base64')}'`).join(' ');
  const csp = `default-src 'none'; script-src ${hashes}; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; font-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'`;
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="referrer" content="no-referrer">
<meta name="description" content="${desc}">
<title>${title}</title>
<style>${css}</style>
</head>
<body>
${body}
${s.map(js => `<script>${js}</script>`).join('\n')}
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
${s.map(js => `<script>${js}</script>`).join('\n')}
`;
  writeFileSync(join(root, 'dist/threadlens-artifact.html'), html);
}
console.log('built dist/index.html and dist/threadlens-artifact.html');
