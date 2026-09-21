/*! Threadlens UI. MIT License. No network access: all reading happens in this tab. */
(function () {
  'use strict';
  const core = window.ThreadlensCore;
  const LEX = window.TL_LEX, VADER = window.TL_VADER, SAMPLE = window.TL_SAMPLE;
  const ENV = window.TL_ENV || 'web';
  const analyzer = core.createAnalyzer(LEX, VADER);

  const MAX_BYTES = 25 * 1024 * 1024;
  const MAX_MESSAGES = 250000;
  const RATE = { max: 8, windowMs: 10 * 60 * 1000 };
  const runs = [];

  const $ = s => document.querySelector(s);
  const el = (tag, attrs, ...kids) => {
    const n = document.createElement(tag);
    for (const k in attrs || {}) {
      if (k === 'class') n.className = attrs[k];
      else if (k === 'html') n.innerHTML = attrs[k];
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== false && attrs[k] != null) n.setAttribute(k, attrs[k]);
    }
    for (const c of kids.flat()) if (c != null) n.append(c.nodeType ? c : document.createTextNode(String(c)));
    return n;
  };
  const SVGNS = 'http://www.w3.org/2000/svg';
  const sv = (tag, attrs) => { const n = document.createElementNS(SVGNS, tag); for (const k in attrs) n.setAttribute(k, attrs[k]); return n; };
  const color = i => `var(--s${(i % 8) + 1})`;

  const state = { raw: null, source: '', isSample: false, lens: 'debate', res: null };

  /* ------------------------------------------------------------ input */

  function showError(msg) { const e = $('#err'); e.textContent = msg; e.hidden = !msg; }

  function rateCheck() {
    const now = Date.now();
    while (runs.length && now - runs[0] > RATE.windowMs) runs.shift();
    if (runs.length >= RATE.max) {
      const wait = Math.ceil((RATE.windowMs - (now - runs[0])) / 1000);
      throw new Error(`You've run ${RATE.max} analyses in 10 minutes. Try again in ${wait} s. The limit keeps this tab responsive on large exports.`);
    }
    runs.push(now);
  }

  async function readFile(file) {
    if (file.size > MAX_BYTES) throw new Error(`That file is ${(file.size / 1048576).toFixed(1)} MB. The limit is 25 MB. Export the chat "Without media" to shrink it.`);
    const name = file.name.toLowerCase();
    const buf = await file.arrayBuffer();
    const head = new Uint8Array(buf.slice(0, 4));
    const isZip = head[0] === 0x50 && head[1] === 0x4b;
    if (isZip && (name.endsWith('.docx') || name.endsWith('.doc'))) return docxText(buf);
    if (isZip) return zipText(buf);
    return new TextDecoder('utf-8').decode(buf);
  }

  async function zipText(buf) {
    const zip = await JSZip.loadAsync(buf);
    const txts = Object.values(zip.files).filter(f => !f.dir && /\.txt$/i.test(f.name));
    if (!txts.length) {
      if (zip.files['word/document.xml']) return docxText(buf);
      throw new Error('That zip has no .txt chat inside. Use WhatsApp → Export chat, and upload the zip it creates.');
    }
    txts.sort((a, b) => (/chat/i.test(b.name) - /chat/i.test(a.name)));
    return txts[0].async('string');
  }

  async function docxText(buf) {
    const zip = await JSZip.loadAsync(buf);
    const f = zip.file('word/document.xml');
    if (!f) throw new Error('That .docx could not be read. Save it again from Word, or export the chat as .txt.');
    const xml = await f.async('string');
    const text = xml
      .replace(/<w:tab\/>/g, '\t').replace(/<w:br[^>]*\/>/g, '\n').replace(/<\/w:p>/g, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
    return text;
  }

  async function ingest(getText, source, isSample) {
    showError('');
    try {
      if (!isSample) rateCheck();
      const text = await getText();
      state.raw = text; state.source = source; state.isSample = !!isSample;
      run();
      if (!isSample) $('#lensbar').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    } catch (e) { showError(e.message || String(e)); }
  }

  function run() {
    const parsed = core.parseChat(state.raw, { dateOrder: $('#order').value });
    if (parsed.messages.length > MAX_MESSAGES) throw new Error(`This chat has ${parsed.messages.length.toLocaleString()} messages. The limit is ${MAX_MESSAGES.toLocaleString()}. Trim the export and try again.`);
    state.res = analyzer.analyse(parsed, { anonymise: $('#anon').checked });
    render();
  }

  /* ------------------------------------------------------------ render */

  function render() {
    const { res, lens } = state;
    const R = $('#results');
    R.replaceChildren();
    $('#lens-blurb').textContent = core.LENSES[lens].blurb;
    document.querySelectorAll('.seg button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.lens === lens)));
    if (!res) return;

    const idx = Object.fromEntries(res.people.map((p, i) => [p, i]));
    const days = res.range.days;
    R.append(
      el('div', { class: 'banner' },
        el('div', null,
          el('p', { class: 'eyebrow' }, core.LENSES[lens].title + ' lens'),
          el('h2', null, state.isSample ? 'Sample: a disagreement about a car-free market' : state.source || 'Your conversation')),
        state.isSample ? el('span', { class: 'sample-note' }, 'Sample data. Drop your own export above') : null),
      el('div', { class: 'facts' },
        el('span', null, `${res.totals.messages.toLocaleString()} messages`),
        el('span', null, `${res.totals.words.toLocaleString()} words`),
        el('span', null, `${res.people.length} people`),
        el('span', null, `${core.fmtDate(res.range.from)} → ${core.fmtDate(res.range.to)} (${days} active day${days === 1 ? '' : 's'})`),
        el('span', { class: 'muted' }, `dates read as ${res.dateOrder}`)),
      el('div', { class: 'people', 'aria-label': 'People' },
        res.stats.map(s => el('span', { class: 'chip' }, el('span', { class: 'sw', style: `background:${color(idx[s.name])}` }), s.name, el('span', { class: 'muted' }, `${s.messages}`))))
    );

    const F = core.findings(res, lens);
    R.append(el('div', { class: 'panel' },
      el('h3', null, 'What stands out'),
      el('ul', { class: 'findings' }, F.map(f => el('li', null, el('span', { class: 'pill ' + f.kind }, f.kind), el('span', null, f.text))))));

    const grid = el('div', { class: 'grid2' });
    grid.append(measuresPanel(res, lens, idx));
    const charts = el('div', { style: 'display:grid;gap:20px;min-width:0' });
    charts.append(lineChartPanel(res, idx, lens === 'debate' || lens === 'personal' ? 'heat' : 'n'));
    charts.append(lineChartPanel(res, idx, lens === 'debate' || lens === 'personal' ? 'n' : lens === 'work' ? 'hours' : 'heat'));
    grid.append(charts);
    R.append(grid);

    if (lens === 'debate') {
      const g2 = el('div', { class: 'grid2' });
      g2.append(moralPanel(res, idx), rhetoricPanel(res, idx));
      R.append(g2);
    }
    if ((lens === 'debate' || lens === 'overview') && $('#showq').checked && res.hottest.length) R.append(hottestPanel(res, idx));

    R.append(el('div', { class: 'caveats' },
      el('strong', null, 'Read these numbers carefully'),
      el('ul', null,
        el('li', null, 'Word lists miss sarcasm, quotations (“you said X”) and context. A person quoting an insult gets counted for it.'),
        el('li', null, 'Romanised Hindi and other languages are only partly covered, so tone and heat undercount them.'),
        el('li', null, `Comparisons switch off below ${core.MIN_WORDS_FOR_CLAIM} words per person. Short chats say little.`),
        el('li', null, 'Nothing here measures personality, intelligence or mental health. Treat it as a mirror, not a verdict.'))));

    const toast = el('span', { class: 'toast', 'aria-live': 'polite' });
    const md = () => core.toMarkdown(res, lens);
    const exp = el('div', { class: 'export' },
      el('button', { class: 'btn', type: 'button', onclick: async () => { try { await navigator.clipboard.writeText(md()); toast.textContent = 'Copied'; } catch { toast.textContent = 'Copy blocked by the browser. Select the text in the downloaded report instead.'; } } }, 'Copy report (Markdown)'));
    if (ENV !== 'artifact') {
      exp.append(
        el('button', { class: 'btn', type: 'button', onclick: () => download(`threadlens-${lens}.md`, md(), 'text/markdown') }, 'Download .md'),
        el('button', { class: 'btn', type: 'button', onclick: () => download(`threadlens-${lens}.json`, JSON.stringify(res, null, 1), 'application/json') }, 'Download .json'));
    }
    exp.append(el('button', { class: 'btn ghost', type: 'button', onclick: clearAll }, 'Clear from this tab'), toast);
    R.append(exp);
  }

  function clearAll() {
    state.raw = null; state.res = null; state.isSample = false;
    $('#paste').value = ''; $('#file').value = '';
    $('#results').replaceChildren(el('p', { class: 'muted' }, 'Cleared. The chat is gone from memory. Drop another export above.'));
  }

  function download(name, text, type) {
    const a = el('a', { href: URL.createObjectURL(new Blob([text], { type })), download: name });
    document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  function measuresPanel(res, lens, idx) {
    const keys = Object.keys(core.METRICS).filter(k => core.METRICS[k].lenses.includes(lens));
    const t = el('table');
    t.append(el('thead', null, el('tr', null, el('th', { scope: 'col' }, 'Measure'), res.stats.map(s => el('th', { scope: 'col' }, s.name)))));
    const tb = el('tbody');
    for (const k of keys) {
      const M = core.METRICS[k];
      const vals = res.stats.map(s => s[k]);
      const max = Math.max(...vals.map(v => (v == null ? 0 : Math.abs(v))), 1e-9);
      tb.append(el('tr', null,
        el('th', { scope: 'row' }, M.label, M.fmt === 'rate' ? el('span', { class: 'note' }, 'per 100 words' + (M.note ? ' · ' + M.note : '')) : M.note ? el('span', { class: 'note' }, M.note) : null),
        res.stats.map((s, i) => el('td', { class: 'val' }, el('div', { class: 'bar' },
          el('span', null, core.fmt(s[k], M.fmt)),
          el('i', { style: `width:${s[k] == null ? 0 : Math.round(100 * Math.abs(s[k]) / max)}%;background:${color(idx[s.name])}` }))))));
    }
    t.append(tb);
    return el('div', { class: 'panel' }, el('h3', null, 'Measures'), el('p', { class: 'sub' }, 'Same counting rules for everyone. Bars compare across each row.'), el('div', { class: 'scroll' }, t));
  }

  function lineChartPanel(res, idx, kind) {
    const titles = {
      heat: ['Heat by day', 'Average hostility heuristic of each person\'s messages that day (0–1)'],
      n: ['Messages by day', 'Count of messages each person sent'],
      hours: ['Time of day', 'Messages by hour, all days combined'],
    };
    const [title, sub] = titles[kind];
    const wrap = el('div', { class: 'chart' });
    const legend = el('div', { class: 'legend' }, res.people.map(p => el('span', null, el('i', { class: 'sw', style: `background:${color(idx[p])}` }), p)));
    const panel = el('div', { class: 'panel' }, el('h3', null, title), el('p', { class: 'sub' }, sub), legend, wrap);

    let xs, series;
    if (kind === 'hours') {
      xs = [...Array(24).keys()].map(h => String(h).padStart(2, '0'));
      series = res.stats.map(s => ({ name: s.name, pts: s.hours.slice() }));
    } else {
      xs = res.series.map(d => d.day);
      series = res.people.map(p => ({ name: p, pts: res.series.map(d => (kind === 'heat' ? d.per[p].heat : d.per[p].n)) }));
    }
    const W = 520, H = 200, m = { l: 34, r: 12, t: 10, b: 26 };
    const vals = series.flatMap(s => s.pts).filter(v => v != null);
    let yMax = kind === 'heat' ? Math.max(0.2, Math.ceil(Math.max(...vals, 0) * 10) / 10) : niceMax(Math.max(...vals, 1));
    const x = i => m.l + (xs.length === 1 ? (W - m.l - m.r) / 2 : (i * (W - m.l - m.r)) / (xs.length - 1));
    const y = v => H - m.b - (v / yMax) * (H - m.t - m.b);
    const svg = sv('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': title });
    const g = sv('g', { class: 'grid' });
    const ticks = 4;
    for (let i = 0; i <= ticks; i++) {
      const v = (yMax * i) / ticks;
      g.append(sv('line', { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v) }));
      const t = sv('text', { x: m.l - 6, y: y(v) + 4, 'text-anchor': 'end' }); t.textContent = kind === 'heat' ? v.toFixed(1) : Math.round(v); svg.append(t);
    }
    svg.prepend(g);
    const labelEvery = Math.max(1, Math.ceil(xs.length / 6));
    xs.forEach((d, i) => {
      if (i % labelEvery && i !== xs.length - 1) return;
      const t = sv('text', { x: x(i), y: H - 8, 'text-anchor': i === 0 ? 'start' : i === xs.length - 1 ? 'end' : 'middle' });
      t.textContent = kind === 'hours' ? d : shortDay(d); svg.append(t);
    });
    for (const s of series) {
      const c = color(idx[s.name]);
      let dpath = '', pen = false;
      s.pts.forEach((v, i) => { if (v == null) { pen = false; return; } dpath += (pen ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1); pen = true; });
      svg.append(sv('path', { d: dpath, fill: 'none', stroke: c, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
      if (xs.length <= 45) s.pts.forEach((v, i) => { if (v != null) svg.append(sv('circle', { cx: x(i), cy: y(v), r: 3.5, fill: c, stroke: 'var(--surface)', 'stroke-width': 1.5 })); });
    }
    // hover: crosshair + tooltip
    const cross = sv('line', { y1: m.t, y2: H - m.b, stroke: 'var(--line-strong)', 'stroke-width': 1, visibility: 'hidden' });
    svg.append(cross);
    const hit = sv('rect', { x: m.l, y: m.t, width: W - m.l - m.r, height: H - m.t - m.b, fill: 'transparent' });
    svg.append(hit);
    const tip = el('div', { class: 'tip', hidden: true });
    wrap.append(svg, tip);
    const move = ev => {
      const r = svg.getBoundingClientRect();
      const px = ((ev.clientX - r.left) / r.width) * W;
      const i = Math.max(0, Math.min(xs.length - 1, Math.round(xs.length === 1 ? 0 : ((px - m.l) / (W - m.l - m.r)) * (xs.length - 1))));
      cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); cross.setAttribute('visibility', 'visible');
      tip.hidden = false;
      tip.textContent = (kind === 'hours' ? xs[i] + ':00' : shortDay(xs[i])) + ' · ' + series.map(s => `${s.name}: ${s.pts[i] == null ? '—' : kind === 'heat' ? s.pts[i].toFixed(2) : s.pts[i]}`).join(' · ');
      tip.style.left = Math.min(Math.max((x(i) / W) * r.width, 80), r.width - 80) + 'px';
      tip.style.top = (m.t / H) * r.height + 'px';
    };
    hit.addEventListener('pointermove', move);
    hit.addEventListener('pointerleave', () => { tip.hidden = true; cross.setAttribute('visibility', 'hidden'); });
    // table view for accessibility
    const tbl = el('table', null,
      el('thead', null, el('tr', null, el('th', null, kind === 'hours' ? 'Hour' : 'Day'), series.map(s => el('th', null, s.name)))),
      el('tbody', null, xs.map((d, i) => el('tr', null, el('td', null, d), series.map(s => el('td', null, s.pts[i] == null ? '—' : kind === 'heat' ? s.pts[i].toFixed(2) : s.pts[i]))))));
    panel.append(el('details', null, el('summary', null, 'Show as table'), el('div', { class: 'scroll' }, tbl)));
    return panel;
  }

  function niceMax(v) { const p = Math.pow(10, Math.floor(Math.log10(v))); for (const k of [1, 2, 2.5, 5, 10]) if (k * p >= v) return k * p; return 10 * p; }
  function shortDay(d) { const [y, mo, da] = d.split('-').map(Number); return new Date(y, mo - 1, da).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }); }

  function moralPanel(res, idx) {
    const t = el('table', null,
      el('thead', null, el('tr', null, el('th', null, 'Foundation'), res.stats.map(s => el('th', null, s.name)))),
      el('tbody', null, Object.keys(core.MORAL_LABELS).map(k => {
        const vals = res.stats.map(s => s.moral[k] || 0); const max = Math.max(...vals, 1e-9);
        return el('tr', null, el('th', { scope: 'row' }, core.MORAL_LABELS[k]),
          res.stats.map((s, i) => el('td', { class: 'val' }, el('div', { class: 'bar' }, el('span', null, vals[i].toFixed(2)), el('i', { style: `width:${Math.round(100 * vals[i] / max)}%;background:${color(idx[s.name])}` })))));
      })));
    return el('div', { class: 'panel' }, el('h3', null, 'Moral vocabulary'), el('p', { class: 'sub' }, 'Words per 100 tied to each foundation. Opponents who stress different foundations often talk past each other.'), el('div', { class: 'scroll' }, t));
  }

  function rhetoricPanel(res, idx) {
    const t = el('table', null,
      el('thead', null, el('tr', null, el('th', null, 'Cue'), res.stats.map(s => el('th', null, s.name)))),
      el('tbody', null, Object.keys(core.RHET_LABELS).map(k => el('tr', null, el('th', { scope: 'row' }, core.RHET_LABELS[k]), res.stats.map(s => el('td', null, String(s.rhetoric[k] || 0)))))));
    const panel = el('div', { class: 'panel' }, el('h3', null, 'Rhetorical cues'), el('p', { class: 'sub' }, 'Phrase matches, not verdicts. Open the examples and judge them in context.'), el('div', { class: 'scroll' }, t));
    if ($('#showq').checked) {
      const ex = el('div', { class: 'quotes' });
      for (const s of res.stats) for (const k in s.examples) for (const q of s.examples[k].slice(0, 2))
        ex.append(el('div', { class: 'quote', style: `border-left-color:${color(idx[s.name])}` }, el('span', { class: 'meta' }, `${s.name} · ${core.RHET_LABELS[k]} · ${q.date.toLocaleString()}`), el('p', null, q.text)));
      if (ex.childElementCount) panel.append(el('details', null, el('summary', null, 'Show matched messages'), ex));
    }
    return panel;
  }

  function hottestPanel(res, idx) {
    return el('div', { class: 'panel' }, el('h3', null, 'Hottest messages'), el('p', { class: 'sub' }, 'Highest heat scores. Check whether the words were meant, quoted or joking.'),
      el('div', { class: 'quotes' }, res.hottest.map(h => el('div', { class: 'quote', style: `border-left-color:${color(idx[h.who])}` },
        el('span', { class: 'meta' }, `${h.who} · ${h.date.toLocaleString()} · heat ${h.heat.toFixed(2)}`), el('p', null, h.text)))));
  }

  /* ------------------------------------------------------------ wiring */

  const zone = $('#zone'), file = $('#file');
  $('#pick').addEventListener('click', e => { e.stopPropagation(); file.click(); });
  zone.addEventListener('click', e => { if (e.target === zone || e.target.closest('strong,.formats')) file.click(); });
  zone.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && e.target === zone) { e.preventDefault(); file.click(); } });
  file.addEventListener('change', () => { const f = file.files[0]; if (f) ingest(() => readFile(f), f.name); });
  ['dragenter', 'dragover'].forEach(t => zone.addEventListener(t, e => { e.preventDefault(); zone.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(t => zone.addEventListener(t, e => { e.preventDefault(); zone.classList.remove('over'); }));
  zone.addEventListener('drop', e => { const f = e.dataTransfer.files[0]; if (f) ingest(() => readFile(f), f.name); });
  $('#paste-toggle').addEventListener('click', e => { e.stopPropagation(); const b = $('#paste-box'); b.hidden = !b.hidden; if (!b.hidden) $('#paste').focus(); });
  $('#paste-go').addEventListener('click', () => { const t = $('#paste').value; if (!t.trim()) return showError('Paste the exported chat text first.'); ingest(async () => t, 'Pasted conversation'); });
  $('#load-sample').addEventListener('click', e => { e.stopPropagation(); ingest(async () => SAMPLE, 'Sample', true); });
  document.addEventListener('paste', e => {
    if (e.target.closest && e.target.closest('textarea,input')) return;
    const t = e.clipboardData && e.clipboardData.getData('text');
    if (t && /\d[:.]\d{2}/.test(t)) ingest(async () => t, 'Pasted conversation');
  });
  ['#anon', '#order', '#showq'].forEach(s => $(s).addEventListener('change', () => { if (state.raw) { try { run(); } catch (e) { showError(e.message); } } }));
  document.querySelectorAll('.seg button').forEach(b => b.addEventListener('click', () => { state.lens = b.dataset.lens; render(); }));

  // Open in a working state: the synthetic sample, clearly labelled.
  ingest(async () => SAMPLE, 'Sample', true);
})();
