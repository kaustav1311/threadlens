/*! Threadlens UI. MIT License. No network access: all reading happens in this tab. */
(function () {
  'use strict';
  const core = window.ThreadlensCore;
  const LEX = window.TL_LEX, SAMPLE = window.TL_SAMPLE;
  // VADER is inlined in a packed form to keep the page inside its size budget.
  const VADER = typeof window.TL_VADER === 'string' ? core.unpackVader(window.TL_VADER) : window.TL_VADER;
  const ENV = window.TL_ENV || 'web';
  const analyzer = core.createAnalyzer(LEX, VADER);

  const MAX_BYTES = 25 * 1024 * 1024;
  const MAX_MESSAGES = 250000;
  const RATE = { max: 8, windowMs: 10 * 60 * 1000 };
  const WORKER_MIN_CHARS = 400000;  // below this the main thread finishes before a worker could start
  const COUNT_UP_MS = 600;
  const TOP_DIFFS = 5;
  const POP_MS = 9000;
  const runs = [];

  const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

  const $ = s => document.querySelector(s);
  const el = (tag, attrs, ...kids) => {
    const n = document.createElement(tag);
    for (const k in attrs || {}) {
      if (k === 'class') n.className = attrs[k];
      else if (k === 'html') n.innerHTML = attrs[k];
      else if (k === 'style') n.setAttribute('style', attrs[k]);
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== false && attrs[k] != null) n.setAttribute(k, attrs[k]);
    }
    for (const c of kids.flat()) if (c != null) n.append(c.nodeType ? c : document.createTextNode(String(c)));
    return n;
  };
  const SVGNS = 'http://www.w3.org/2000/svg';
  const sv = (tag, attrs) => { const n = document.createElementNS(SVGNS, tag); for (const k in attrs) n.setAttribute(k, attrs[k]); return n; };
  const color = i => `var(--s${(i % 8) + 1})`;
  const initial = n => (n.trim()[0] || '?').toUpperCase();
  const dateTime = d => new Date(d).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  const state = {
    raw: null, source: '', isSample: false, res: null, busy: false,
    clip: null,          // {from,to} ISO dates, applied at parse time
    fullRange: null,     // the unclipped span, so the clip UI knows its bounds
    totals: false,       // measures shown as raw counts rather than per-100-word rates
  };

  /* --------------------------------------------------------------- input */

  function showError(msg) { const e = $('#err'); e.textContent = msg; e.hidden = !msg; }

  function rateCheck() {
    const now = Date.now();
    while (runs.length && now - runs[0] > RATE.windowMs) runs.shift();
    if (runs.length >= RATE.max) {
      const wait = Math.ceil((RATE.windowMs - (now - runs[0])) / 1000);
      throw new Error(`That's ${RATE.max} analyses in 10 minutes. Give it ${wait} s. The limit exists so a huge export cannot lock up your own browser, not to ration anything.`);
    }
    runs.push(now);
  }

  function setProgress(pct, label) {
    const box = $('#progress');
    box.hidden = pct == null;
    if (pct == null) return;
    const fill = $('#progress-fill');
    fill.style.transform = `scaleX(${Math.max(0, Math.min(1, pct))})`;
    fill.parentNode.setAttribute('aria-valuenow', Math.round(pct * 100));
    $('#progress-label').textContent = label + ' ' + Math.round(pct * 100) + '%';
  }

  function showFileCard(name, bytes) {
    const old = $('#filecard');
    if (old) old.remove();
    const card = el('div', { class: 'filecard', id: 'filecard' },
      el('span', { class: 'dot' }), el('span', null, name),
      el('span', { class: 'size' }, bytes == null ? '' : (bytes / 1024 < 900 ? Math.round(bytes / 1024) + ' KB' : (bytes / 1048576).toFixed(1) + ' MB')));
    $('#progress').before(card);
  }

  /** A short, plain-spoken pop-up. Dismissible, auto-expiring, never more than two deep. */
  function pop(kind, text) {
    const box = $('#toastbox');
    if (!box) return;
    while (box.childElementCount >= 2) box.firstElementChild.remove();
    const node = el('div', { class: 'pop', role: 'status' }, el('b', null, kind), el('p', null, text));
    node.addEventListener('click', () => node.remove());
    box.append(node);
    setTimeout(() => node.remove(), POP_MS);
  }

  async function readFile(file) {
    if (file.size > MAX_BYTES) throw new Error(`That file is ${(file.size / 1048576).toFixed(1)} MB and the limit is 25 MB. Export the chat "Without media" and it will shrink dramatically.`);
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
      throw new Error('That zip has no .txt chat inside. Use WhatsApp → Export chat, and drop in the zip it hands you.');
    }
    txts.sort((a, b) => (/chat/i.test(b.name) - /chat/i.test(a.name)));
    return txts[0].async('string');
  }

  async function docxText(buf) {
    const zip = await JSZip.loadAsync(buf);
    const f = zip.file('word/document.xml');
    if (!f) throw new Error('That .docx could not be read. Save it again from Word, or export the chat as .txt.');
    const xml = await f.async('string');
    return xml
      .replace(/<w:tab\/>/g, '\t').replace(/<w:br[^>]*\/>/g, '\n').replace(/<\/w:p>/g, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  }

  /* -------------------------------------------------------------- worker
   * Big exports are analysed off the main thread so the page keeps painting and
   * the progress bar keeps moving. The worker is built from a Blob of the same
   * core.js the page uses, which is why the CSP allows worker-src blob: and
   * nothing else. If workers are unavailable (or a host CSP blocks the blob) we
   * fall back to the main thread and the result is identical.
   */
  const HARNESS = `
    var A = null;
    self.onmessage = function (e) {
      var d = e.data;
      try {
        if (d.type === 'init') { A = ThreadlensCore.createAnalyzer(d.lex, d.vader); self.postMessage({ type: 'ready' }); return; }
        var post = function (phase, pct) { self.postMessage({ type: 'progress', phase: phase, pct: pct }); };
        var parsed = ThreadlensCore.parseChat(d.text, { dateOrder: d.dateOrder, from: d.from, to: d.to, onProgress: function (p) { post('Reading messages', p * 0.35); } });
        if (!parsed.messages.length) throw new Error('UNPARSEABLE:' + (parsed.lineCount || 0) + ':' + (parsed.firstLine || ''));
        if (parsed.messages.length > d.maxMessages) throw new Error('This chat has ' + parsed.messages.length.toLocaleString() + ' messages and the limit is ' + d.maxMessages.toLocaleString() + '. Trim the export and try again.');
        var res = A.analyse(parsed, { anonymise: d.anonymise, onProgress: function (p) { post('Scoring every message', 0.35 + p * 0.5); } });
        post('Weighing the argument', 0.88);
        res.rigor; // force the lazy pass here, where it costs the user nothing
        post('Done', 1);
        self.postMessage({ type: 'done', res: res });
      } catch (err) { self.postMessage({ type: 'error', message: (err && err.message) || String(err) }); }
    };`;

  let workerP = null;
  function getWorker() {
    if (workerP) return workerP;
    workerP = new Promise((resolve, reject) => {
      // The worker's copy of the core is the page's own script#tl-core, read back
      // out of the DOM. Embedding it a second time as a string cost ~38 KB.
      const coreTag = document.getElementById('tl-core');
      const coreSrc = coreTag && coreTag.textContent;
      if (typeof Worker !== 'function' || !coreSrc || !window.URL || !URL.createObjectURL) return reject(new Error('no worker'));
      let w;
      try {
        w = new Worker(URL.createObjectURL(new Blob([coreSrc + HARNESS], { type: 'text/javascript' })));
      } catch (e) { return reject(e); }
      const fail = e => reject(e instanceof Error ? e : new Error('worker failed'));
      w.addEventListener('error', fail, { once: true });
      w.addEventListener('message', function onready(ev) {
        if (ev.data && ev.data.type === 'ready') { w.removeEventListener('message', onready); w.removeEventListener('error', fail); resolve(w); }
      });
      w.postMessage({ type: 'init', lex: LEX, vader: VADER });
    }).catch(e => { workerP = null; throw e; });
    return workerP;
  }

  function analyseInWorker(w, text) {
    return new Promise((resolve, reject) => {
      const onMsg = ev => {
        const d = ev.data;
        if (d.type === 'progress') return setProgress(d.pct, d.phase);
        w.removeEventListener('message', onMsg);
        if (d.type === 'error') {
          const u = /^UNPARSEABLE:(\d+):([\s\S]*)$/.exec(d.message);
          reject(u ? unparseableError(+u[1], u[2]) : new Error(d.message));
        }
        else resolve(d.res);
      };
      w.addEventListener('message', onMsg);
      w.postMessage({
        type: 'run', text, dateOrder: $('#order').value, anonymise: $('#anon').checked,
        maxMessages: MAX_MESSAGES, from: state.clip && state.clip.from, to: state.clip && state.clip.to,
      });
    });
  }

  /**
   * "No messages found" is useless on its own. Nearly every failed paste is one of
   * two things: text copied out of the WhatsApp window (which carries no
   * timestamps) or a screenshot's worth of prose. Say which, and show the shape
   * of a line that would work.
   */
  function unparseableError(n, first) {
    if (!n) return new Error('There was nothing to read — the box was empty.');
    return new Error(
      `Read ${n} line${n === 1 ? '' : 's'}, but could not find a speaker on any of them. ` +
      (first ? `The first line reads: “${first.trim()}”. ` : '') +
      'A line needs either a timestamp — “21/09/2026, 01:02 - Ravi: text”, ' +
      '“[01:02, 21/09/2026] Ravi: text”, “[21/09, 01:02] Ravi: text” — ' +
      'or at least a name and a colon, “Ravi: text”, which is read in order with no times. ' +
      'For the full analysis use the chat menu → More → Export chat → Without media.');
  }

  function assertParsed(parsed) {
    if (parsed.messages.length) return parsed;
    throw unparseableError(parsed.lineCount || 0, parsed.firstLine || '');
  }

  function analyseHere(text) {
    setProgress(0.05, 'Reading messages');
    const parsed = assertParsed(core.parseChat(text, { dateOrder: $('#order').value, from: state.clip && state.clip.from, to: state.clip && state.clip.to }));
    if (parsed.messages.length > MAX_MESSAGES) throw new Error(`This chat has ${parsed.messages.length.toLocaleString()} messages and the limit is ${MAX_MESSAGES.toLocaleString()}. Trim the export and try again.`);
    setProgress(0.6, 'Scoring every message');
    return analyzer.analyse(parsed, { anonymise: $('#anon').checked });
  }

  async function ingest(getText, source, isSample) {
    if (state.busy) return;
    showError('');
    state.busy = true;
    $('#results').setAttribute('aria-busy', 'true');
    const wasSample = state.isSample;
    try {
      if (!isSample) rateCheck();
      const text = await getText();
      state.raw = text; state.source = source; state.isSample = !!isSample;
      setProgress(0.02, 'Reading messages');
      let res;
      if (text.length >= WORKER_MIN_CHARS) {
        try { res = await analyseInWorker(await getWorker(), text); }
        catch (e) { res = analyseHere(text); }
      } else {
        res = analyseHere(text);
      }
      state.res = res;
      if (!state.clip) state.fullRange = { from: res.range.from, to: res.range.to };
      setProgress(null);
      render();
      if (!isSample) {
        $('#lensbar').scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'start' });
        // The handover from sample to real data is the moment the old build hid completely.
        if (wasSample) pop('Now reading your chat', 'The sample is gone. Everything below is your conversation, scored in this tab.');
        announce(res);
      }
    } catch (e) {
      setProgress(null);
      showError(e.message || String(e));
    } finally {
      state.busy = false;
      $('#results').setAttribute('aria-busy', 'false');
    }
  }

  /** One pop-up, and only when there is genuinely one thing worth saying out loud. */
  function announce(res) {
    const S = res.stats.filter(s => s.name !== 'Others').slice(0, 2);
    if (S.length < 2) return;
    const [a, b] = S;
    const tot = a.initiations + b.initiations;
    if (tot >= 6) {
      const hi = a.initiations >= b.initiations ? a : b;
      const share = hi.initiations / tot;
      if (share >= 0.75) return pop('Worth noticing', `${hi.name} starts ${Math.round(share * 100)}% of the conversations here. That is rarely an accident.`);
    }
    for (const s of S) {
      if (s.heatLast > 0.12 && s.heatLast >= 2 * Math.max(s.heatFirst, 0.03))
        return pop('Temperature check', `${s.name}'s messages got measurably hotter as this went on. The Debate lens has the curve.`);
    }
    const q = S.find(s => s.questionRate < 0.03 && s.textMessages >= 20);
    if (q) return pop('Worth noticing', `${q.name} asked something in under 3% of their messages. A lot of telling, not much asking.`);
  }

  function rerun() {
    if (!state.raw) return;
    ingest(async () => state.raw, state.source, state.isSample);
  }

  /* --------------------------------------------------------------- render */

  /** Count a number up on first paint. Short, once, skipped entirely for reduced motion. */
  function countUp(node, to, fmt) {
    const final = fmt(to);
    // Reserve the final width, or the label underneath jitters while the digits change.
    node.style.minWidth = final.length + 'ch';
    if (reduceMotion() || !isFinite(to)) { node.textContent = final; return; }
    const t0 = performance.now();
    const step = now => {
      const k = Math.min(1, (now - t0) / COUNT_UP_MS);
      node.textContent = k >= 1 ? final : fmt(to * (1 - Math.pow(1 - k, 3)));
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  /* ------------------------------------------------------------- one report
   * There used to be five lenses showing the same containers with different
   * metric subsets, which meant reading the same chat five times to find the one
   * view that applied to it. There is now one page, and each section appears only
   * when the chat actually supports it: no timestamps means no timeline, no
   * argument means no rigor section. The relationship selector reorders and
   * opens sections. It still never touches a score.
   */
  const SECTION_FOR_RELATION = {
    partner: 'tone', family: 'tone', friend: 'timeline',
    colleague: 'timeline', group: 'timeline', stranger: 'rigor',
  };

  const SECTION_LABELS = {
    summary: 'Summary', measures: 'Differences', timeline: 'Over time',
    tone: 'Conduct', rigor: 'The argument',
  };

  /** A section of the report, carrying the anchor the nav and deep links use. */
  function section(id, title, ...kids) {
    return el('section', { class: 'report-section', id: 'sec-' + id, 'data-section': id },
      el('h2', { class: 'section-h' }, title), ...kids.filter(Boolean));
  }

  /** Findings across every lens, deduplicated: one chat, one list. */
  function allFindings(res) {
    const seen = new Set(), out = [];
    for (const lens of Object.keys(core.LENSES)) {
      if (lens === 'rigor' && !res.rigor.applies) continue;
      for (const f of core.findings(res, lens)) {
        const key = f.short || f.text;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(f);
      }
    }
    // Caveats last: they are context for the findings above them, not headlines.
    return out.filter(f => f.kind !== 'caveat').concat(out.filter(f => f.kind === 'caveat'));
  }

  function buildSectionNav(ids) {
    const nav = $('#seg');
    nav.replaceChildren();
    for (const id of ids) {
      nav.append(el('a', {
        href: '#sec-' + id,
        onclick: e => {
          e.preventDefault();
          const t = $('#sec-' + id);
          if (t) t.scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'start' });
        },
      }, SECTION_LABELS[id]));
    }
  }

  function render() {
    const { res } = state;
    const R = $('#results');
    R.replaceChildren();
    // keep `wrap` -- it carries the page gutter and max width
    R.className = 'wrap results swap';
    void R.offsetWidth;
    if (!res) { $('#seg').replaceChildren(); $('#lens-blurb').textContent = ''; return; }

    const idx = Object.fromEntries(res.people.map((p, i) => [p, i]));
    const days = res.range.days;
    const G = res.rigor;
    const rel = $('#relation').value;

    /* Sample or yours: said once, plainly, above every number. */
    R.append(state.isSample
      ? el('div', { class: 'demo-strip' },
        el('b', null, 'Sample data'),
        el('span', null, 'Not your numbers. A made-up argument about a car-free market, so you can see what the tool does before feeding it anything real.'),
        el('button', {
          class: 'btn', type: 'button',
          onclick: () => { $('#zone').scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'center' }); $('#pick').focus(); },
        }, 'Analyse your own'))
      : el('div', { class: 'live-strip' },
        el('b', null, 'Your chat'),
        el('span', null, `Read inside this tab and never uploaded. ${res.totals.messages.toLocaleString()} messages scored locally.`)));

    R.append(el('p', { class: 'statusline' },
      `> threadlens --source ${state.isSample ? 'sample' : 'local'}`
      + (rel ? ` --with ${rel}` : '')
      + (state.clip ? ' --clip' : '')
      + (res.undated ? ' --no-dates' : '')
      + ` --messages ${res.totals.messages}`,
      el('span', { class: 'caret', 'aria-hidden': 'true' })));

    // No dates in the source means nothing to clip by.
    if (!state.isSample && !res.undated) R.append(clipBar(res));

    R.append(el('div', { class: 'banner' },
      el('div', { class: 'hrow' },
        el('h2', null, state.isSample ? 'A disagreement about a car-free market' : state.source || 'Your conversation'),
        el('span', { class: 'tag compare' }, 'Same ruler, both sides')),
      el('div', { class: 'facts' },
        el('span', null, `${res.totals.messages.toLocaleString()} messages`),
        el('span', null, `${res.totals.words.toLocaleString()} words`),
        el('span', null, `${res.people.length} ${res.people.length === 1 ? 'person' : 'people'}`),
        // An undated transcript has an order but no clock. Saying so once here is
        // better than printing a date range that was invented a moment ago.
        res.undated
          ? el('span', null, 'no timestamps — order only')
          : el('span', null, `${core.fmtDate(res.range.from)} → ${core.fmtDate(res.range.to)}`),
        res.undated ? null : el('span', null, `${days} active day${days === 1 ? '' : 's'}`),
        (G.languages && G.languages.length > 1)
          ? el('span', null, `languages ${G.languages.join(' + ')}`)
          : null)));

    /* ---------------------------------------------------------- sections */
    const made = [];
    const add = (id, node) => { made.push(id); R.append(node); };

    add('summary', section('summary', 'The short version',
      scoreCards(res, idx, 'overview'),
      findingCards(res, allFindings(res))));

    add('measures', section('measures', 'Where you differ most',
      measuresDrawer(res, idx)));

    if (!res.undated) {
      const grid = el('div', { class: 'grid2' });
      grid.append(chartPanel(res, idx, 'n'), chartPanel(res, idx, 'heat'));
      add('timeline', section('timeline', 'Over time', grid, chartPanel(res, idx, 'hours')));
    } else {
      R.append(el('p', { class: 'muted undated-note' },
        'This was pasted without timestamps, so it is read in order only. '
        + 'Reply times, conversation starts, time of day and the daily charts are all left out — '
        + 'export the chat instead of copying the messages if you want those.'));
    }

    const toneBits = el('div');
    const g3 = el('div', { class: 'grid2' });
    g3.append(moralPanel(res, idx), rhetoricPanel(res, idx));
    toneBits.append(g3);
    if ($('#showq').checked && res.hottest.length) toneBits.append(hottestPanel(res, idx));
    add('tone', section('tone', 'Conduct and tone', toneBits));

    if (G.applies) {
      const g4 = el('div', { class: 'grid2' });
      g4.append(unansweredPanel(res, idx), driftPanel(res, idx));
      add('rigor', section('rigor', 'How the argument was argued',
        rigorCards(res, idx), rigorKnowhow(res), claimLedger(res, idx), g4));
    } else {
      // Nothing in this chat is an argument. Printing a ledger and a drift chart
      // anyway is how this used to produce a confident analysis of small talk.
      add('rigor', section('rigor', 'How the argument was argued',
        el('div', { class: 'knowhow' },
          el('h4', null, 'There is no argument here to score'),
          el('p', null, `All ${G.episodes} conversation${G.episodes === 1 ? '' : 's'} in this chat read as `
            + 'small talk, logistics or agreement — nobody is contesting anything at length. This section measures how a '
            + 'disagreement was conducted: sourcing, answering, staying on topic. With no disagreement to measure, '
            + 'every one of those would be a confident zero about nothing.'),
          el('p', null, 'Everything above still applies. That is the part worth reading for a chat like this.'))));
    }

    // The relationship says which section to lead with. It reorders the nav and
    // scrolls; it does not change a single number.
    const lead = SECTION_FOR_RELATION[rel];
    buildSectionNav(lead && made.includes(lead) ? [lead, ...made.filter(x => x !== lead)] : made);
    $('#lens-blurb').textContent = G.applies
      ? `One report, read top to bottom. ${G.episodesScored} of ${G.episodes} conversations here ${G.episodesScored === 1 ? "is an argument" : "are arguments"}, and only ${G.episodesScored === 1 ? "that one is" : "those are"} scored.`
      : 'One report, read top to bottom. Nothing in this chat is an argument, so the last section says so rather than scoring one.';

    R.append(el('div', { class: 'caveats' },
      el('strong', null, 'Before you screenshot this at someone'),
      el('ul', null,
        el('li', null, 'Word lists cannot hear sarcasm, and quoting someone else’s insult counts against you.'),
        el('li', null, 'Tone and heat undercount every language the sentiment lexicon does not cover, which is all of them except English.'),
        el('li', null, `Comparisons switch off below ${core.MIN_WORDS_FOR_CLAIM} words per person, because short chats say nothing.`),
        el('li', null, 'Nothing here measures personality, intelligence, compatibility or mental health. It is a mirror, not a verdict.'))));

    // The written report follows the richest section this chat earned.
    const reportLens = G.applies ? 'rigor' : 'debate';
    const toast = el('span', { class: 'toast', 'aria-live': 'polite' });
    const md = () => core.toMarkdown(res, reportLens);
    const exp = el('div', { class: 'export' },
      el('button', { class: 'btn', type: 'button', onclick: async () => { try { await navigator.clipboard.writeText(md()); toast.textContent = 'Copied'; } catch { toast.textContent = 'The browser blocked the clipboard. Download it instead.'; } } }, 'Copy report'));
    if (ENV !== 'artifact') {
      exp.append(
        el('button', { class: 'btn', type: 'button', onclick: () => download('threadlens-report.md', md(), 'text/markdown') }, 'Download .md'),
        el('button', { class: 'btn', type: 'button', onclick: () => download('threadlens-report.json', JSON.stringify(res, null, 1), 'application/json') }, 'Download .json'));
    }
    exp.append(el('button', { class: 'btn ghost', type: 'button', onclick: clearAll }, 'Forget this chat'), toast);
    R.append(exp);
  }

  function clearAll() {
    state.raw = null; state.res = null; state.isSample = false;
    $('#paste').value = ''; $('#file').value = '';
    const fc = $('#filecard'); if (fc) fc.remove();
    $('#results').replaceChildren(el('div', { class: 'knowhow' },
      el('h4', null, 'Cleared'),
      el('p', null, 'Gone. It only ever lived in this tab’s memory, and now it does not. Drop another export above, or load the sample again.')));
    pop('Cleared', 'That chat is out of memory. Nothing was ever written anywhere else.');
  }

  function download(name, text, type) {
    const a = el('a', { href: URL.createObjectURL(new Blob([text], { type })), download: name });
    document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  /* ------------------------------------------------------------------ clip */

  const isoDay = d => new Date(d).toISOString().slice(0, 10);

  /**
   * Windows worth offering, computed from the chat itself rather than from the
   * calendar: the last 30 and 90 days OF THIS CHAT, its busiest stretch, and the
   * week it got hottest. "Last 30 days" relative to today is useless for an
   * export of an argument that finished in March.
   */
  function clipPresets(res) {
    const days = res.series.map(d => d.day);
    if (!days.length) return [];
    const last = days[days.length - 1], first = days[0];
    const minus = (day, n) => isoDay(new Date(new Date(day).getTime() - n * 864e5));
    const out = [{ id: 'all', label: 'Everything', from: null, to: null }];
    const span = (new Date(last) - new Date(first)) / 864e5;
    if (span > 30) out.push({ id: '30', label: 'Last 30 days of the chat', from: minus(last, 30), to: null });
    if (span > 90) out.push({ id: '90', label: 'Last 90 days of the chat', from: minus(last, 90), to: null });

    // Busiest 30-day window and hottest 7-day window, by a simple slide over the
    // day series. Both are named by what they are, not by a date the user has to decode.
    const total = d => res.people.reduce((a, p) => a + (d.per[p] ? d.per[p].n : 0), 0);
    const heat = d => {
      const vals = res.people.map(p => (d.per[p] ? d.per[p].heat : null)).filter(v => v != null);
      return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
    };
    const window = (size, score) => {
      let best = null;
      for (let i = 0; i < res.series.length; i++) {
        const from = res.series[i].day, to = isoDay(new Date(new Date(from).getTime() + (size - 1) * 864e5));
        let s = 0, n = 0;
        for (let j = i; j < res.series.length && res.series[j].day <= to; j++) { s += score(res.series[j]); n++; }
        if (n > 1 && (!best || s > best.s)) best = { s, from, to };
      }
      return best;
    };
    if (span > 35) {
      const b = window(30, total);
      if (b) out.push({ id: 'busiest', label: 'Its busiest month', from: b.from, to: b.to });
    }
    if (span > 10) {
      const h = window(7, heat);
      if (h && h.s > 0) out.push({ id: 'hottest', label: 'The week it got worst', from: h.from, to: h.to });
    }
    return out;
  }

  function clipBar(res) {
    const presets = clipPresets(res);
    const bar = el('div', { class: 'clipbar' });
    // Pre-filled with the chat's own first and last day, not left blank. Two empty
    // boxes with invisible min/max made you guess the range you were allowed to pick
    // from; showing it is the whole point of a custom window.
    const span = state.fullRange || res.range;
    const from = el('input', {
      type: 'date', id: 'clip-from', 'aria-label': 'Analyse from',
      value: (state.clip && state.clip.from) || (span ? isoDay(span.from) : ''),
    });
    const to = el('input', {
      type: 'date', id: 'clip-to', 'aria-label': 'Analyse until',
      value: (state.clip && state.clip.to) || (span ? isoDay(span.to) : ''),
    });
    if (span) {
      for (const inp of [from, to]) { inp.min = isoDay(span.from); inp.max = isoDay(span.to); }
    }
    const apply = (f, t) => {
      state.clip = (f || t) ? { from: f || null, to: t || null } : null;
      if (state.raw) ingest(async () => state.raw, state.source, state.isSample);
    };

    const sel = el('select', { 'aria-label': 'Clip to a window', onchange: e => {
      const p = presets.find(x => x.id === e.target.value);
      if (p) apply(p.from, p.to);
    } });
    for (const p of presets) sel.append(el('option', { value: p.id }, p.label));

    bar.append(
      el('span', { class: 'kbd' }, 'Clip'),
      sel,
      el('span', { class: 'clip-dates' }, from, el('span', { class: 'muted' }, 'to'), to),
      el('button', { class: 'btn tiny', type: 'button', onclick: () => apply(from.value, to.value) }, 'Apply'),
      state.clip ? el('button', { class: 'btn tiny ghost', type: 'button', onclick: () => apply(null, null) }, 'Clear clip') : null,
      el('span', { class: 'clip-note muted' },
        state.clip
          ? `Clipped: ${res.totals.messages.toLocaleString()} messages in this window.`
          : `Whole chat: ${res.totals.messages.toLocaleString()} messages.`));
    return bar;
  }

  /* ------------------------------------------------------------ scorecards */

  function sparkline(values, stroke) {
    const W = 200, H = 30;
    const s = sv('svg', { class: 'spark', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', 'aria-hidden': 'true' });
    const max = Math.max(...values, 1);
    const x = i => (values.length === 1 ? W / 2 : (i * W) / (values.length - 1));
    const y = v => H - 2 - (v / max) * (H - 4);
    let d = '';
    values.forEach((v, i) => { d += (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1); });
    const path = sv('path', { class: 'line', d, fill: 'none', stroke, 'stroke-width': 2 });
    path.style.setProperty('--len', Math.max(W, values.length * 6));
    s.append(path);
    return s;
  }

  function statBlock(value, label, fmt) {
    const b = el('b', null, '');
    countUp(b, value, fmt);
    return el('div', { class: 'stat' }, b, el('span', null, label));
  }

  function personHead(name, sub) {
    return el('div', { class: 'who' },
      el('span', { class: 'av', 'aria-hidden': 'true' }, initial(name)),
      el('div', null, el('div', { class: 'nm' }, name), el('div', { class: 'sub' }, sub)));
  }

  function scoreCards(res, idx, lens) {
    const wrap = el('div', { class: 'cards' });
    for (const s of res.stats) {
      const c = color(idx[s.name]);
      const daily = res.series.map(d => (d.per[s.name] ? d.per[s.name].n : 0));
      wrap.append(el('div', { class: 'card', style: `--who:${c}` },
        personHead(s.name, `${s.messages.toLocaleString()} messages · ${s.words.toLocaleString()} words`),
        el('div', { class: 'body' },
          el('div', { class: 'stats' },
            statBlock(s.share * 100, 'share of messages', v => Math.round(v) + '%'),
            statBlock(s.questionRate * 100, 'messages that ask', v => Math.round(v) + '%'),
            lens === 'work' || lens === 'personal'
              ? statBlock(s.replyMedianMin == null ? NaN : s.replyMedianMin, 'median reply', v => core.fmtMins(v))
              : statBlock(s.heatMean, 'mean heat', v => v.toFixed(2)),
            statBlock(s.initiations, 'conversations started', v => String(Math.round(v)))),
          el('span', { class: 'sr' }, `${s.name} sent ${s.messages} messages over ${res.range.days} active days.`),
          sparkline(daily, c))));
    }
    return wrap;
  }

  /** A "how was this computed" note that opens in place. */
  function why(text) {
    const note = el('p', { class: 'note', hidden: true });
    note.textContent = text;
    const btn = el('button', {
      class: 'why', type: 'button', 'aria-expanded': 'false',
      'aria-label': 'How this was computed',
      onclick: e => { const open = note.hidden; note.hidden = !open; e.currentTarget.setAttribute('aria-expanded', String(open)); },
    }, '?');
    return [btn, note];
  }

  function rigorCards(res, idx) {
    const G = res.rigor;
    const wrap = el('div', { class: 'cards' });
    for (const name of res.people) {
      const p = G.people[name];
      if (!p) continue;
      const body = el('div', { class: 'body' });

      const scoreEl = el('b', null, '');
      countUp(scoreEl, p.score == null ? NaN : p.score, v => (isFinite(v) ? String(Math.round(v)) : '—'));
      body.append(el('div', { class: 'score' }, scoreEl, el('span', null, '/ 100')));

      // Strongest and weakest component, stated as fact rather than as a judgement.
      const named = Object.keys(core.RIGOR_WEIGHTS).filter(k => p.components[k] != null);
      if (named.length) {
        const best = named.reduce((x, k) => (p.components[k] > p.components[x] ? k : x), named[0]);
        const worst = named.reduce((x, k) => (p.components[k] < p.components[x] ? k : x), named[0]);
        body.append(el('div', { class: 'verdict' }, `strongest ${core.RIGOR_LABELS[best]} · weakest ${core.RIGOR_LABELS[worst]}`));
      }

      const bd = el('div', { class: 'breakdown' });
      for (const k of Object.keys(core.RIGOR_WEIGHTS)) {
        const v = p.components[k];
        const [btn, note] = why(core.RIGOR_HOW[k] + ` Worth ${core.RIGOR_WEIGHTS[k]} of 100.`);
        const track = el('div', { class: 'track' });
        const fill = el('i');
        fill.style.setProperty('--w', v == null ? 0 : v);
        track.append(fill);
        bd.append(el('div', { class: 'brow' },
          el('span', { class: 'lbl' }, core.RIGOR_LABELS[k], btn),
          el('span', { class: 'v' }, v == null ? 'n/a' : v.toFixed(2)),
          track, note));
      }
      body.append(bd);

      wrap.append(el('div', { class: 'card', style: `--who:${color(idx[name])}` },
        personHead(name, `${p.claims} claim${p.claims === 1 ? '' : 's'} · ${p.checkableClaims} checkable · ${p.questionsAnswered}/${p.questionsPutToThem} answered`),
        body));
    }
    return wrap;
  }

  function rigorKnowhow(res) {
    const G = res.rigor;
    const A = G.applicability;
    const box = el('div', { class: 'knowhow' });
    // Rigor asks "did you source that?". On a chat with almost no factual claims
    // that is the wrong question, and saying so is more honest than a number.
    if (A && A.weak) {
      box.append(
        el('h4', null, 'Careful — this may be the wrong lens'),
        el('p', null, `Only ${A.claims} factual claim${A.claims === 1 ? '' : 's'} in ${A.messages.toLocaleString()} messages `
          + `(${A.claimsPerMessage.toFixed(2)} per message). Rigor is built for an argument where people assert things and `
          + 'are asked to back them up. This reads more like conversation, so Sourcing and Answering will be thin and the '
          + 'scores below are not worth much. Overview or Personal will tell you more.'));
    }
    const mix = G.questionMix;
    box.append(
      el('h4', null, 'How to read this'),
      el('ul', null,
        el('li', null, 'The score is about conduct, not correctness. A well-argued case for something wrong still scores well, and that is deliberate.'),
        el('li', null, `The opening topic was read as: ${G.topicTerms.slice(0, 8).join(', ')}. Drift is measured against that, so a chat that legitimately moves on will show drift.`),
        el('li', null, 'Components marked n/a did not apply — nobody asked that person a question, say — so they drop out of the average rather than scoring zero.'),
        // The single most important thing to say about a Rigor result: it did not
        // read the whole chat, and here is the part it did read.
        el('li', null, `Split into ${G.episodes} conversation${G.episodes === 1 ? '' : 's'} at six-hour gaps, of which `
          + `${G.episodesScored} ${G.episodesScored === 1 ? 'was an argument' : 'were arguments'} and got scored — `
          + `${G.scoredMessages.toLocaleString()} of ${res.totals.messages.toLocaleString()} messages`
          + (G.scoredRange && !res.undated
            ? `, from ${core.fmtDate(G.scoredRange.from)} to ${core.fmtDate(G.scoredRange.to)}.`
            : '.')
          + ' The small talk is left out of every number here.'),
        mix && (mix.phatic || mix.rhetorical)
          ? el('li', null, `Of ${(mix.phatic + mix.rhetorical + mix.substantive).toLocaleString()} questions in the whole chat, `
            + `${mix.substantive.toLocaleString()} actually asked for something. `
            + `${mix.phatic.toLocaleString()} ${mix.phatic === 1 ? 'was a check-in' : 'were check-ins'} like “Wbu?” `
            + `and ${mix.rhetorical.toLocaleString()} ${mix.rhetorical === 1 ? 'was' : 'were'} rhetorical. `
            + 'Only the first kind can go unanswered.')
          : null,
        el('li', null, 'Conduct and Calibration count the share of messages that carried the thing, not words per 100 — being brief is neither rewarded nor punished.'),
        el('li', null, 'Nothing here checks whether a claim is true. The ledger tells you what to go and check.')));
    return box;
  }

  /* -------------------------------------------------------------- findings */

  function findingCards(res, F) {
    const ul = el('ul', { class: 'finds' });
    for (const f of F) {
      const short = f.short || (f.text.length > 78 ? f.text.slice(0, 74).replace(/\s\S*$/, '') + '…' : f.text);
      const li = el('li', null,
        el('span', { class: 'tag ' + f.kind }, f.kind),
        el('p', { class: 'hd' }, short));
      if (short !== f.text) li.append(el('details', null, el('summary', null, 'why?'), el('p', null, f.text)));
      ul.append(li);
    }
    return el('div', null, ul);
  }

  /* ------------------------------------------------------- measures drawer */

  function diffScore(res, key) {
    const S = res.stats.filter(s => s.name !== 'Others').slice(0, 2);
    if (S.length < 2) return 0;
    const a = Math.abs(S[0][key] || 0), b = Math.abs(S[1][key] || 0);
    const hi = Math.max(a, b), lo = Math.min(a, b);
    if (!hi) return 0;
    return (hi - lo) / hi;
  }

  /**
   * One measure for one person, in whichever view is showing.
   * A rate answers "who leans on this more"; a total answers "how often did it
   * actually happen". Showing only the rate leaves a reader unable to tell four
   * instances from four hundred, which is why both live in the same container.
   */
  function measureValue(s, k, M, asTotals) {
    if (asTotals && M.count) return { v: s.counts ? (s.counts[M.count] || 0) : 0, fmt: 'int' };
    return { v: s[k], fmt: M.fmt };
  }

  function measuresTable(res, keys, idx, asTotals) {
    const t = el('table');
    t.append(el('thead', null, el('tr', null, el('th', { scope: 'col' }, 'Measure'), res.stats.map(s => el('th', { scope: 'col', class: 'num' }, s.name)))));
    const tb = el('tbody');
    for (const k of keys) {
      const M = core.METRICS[k];
      const cells = res.stats.map(s => measureValue(s, k, M, asTotals));
      const max = Math.max(...cells.map(c => (c.v == null ? 0 : Math.abs(c.v))), 1e-9);
      // Only a rate metric has a totals view; a percentage or a median has no
      // meaningful "total", so its note and value are left alone.
      const unit = M.fmt === 'rate' ? (asTotals && M.count ? 'times, in total' : 'per 100 words') : null;
      const note = [unit, M.note].filter(Boolean).join(' · ');
      tb.append(el('tr', null,
        el('th', { scope: 'row' }, M.label, note ? el('span', { class: 'note' }, note) : null),
        cells.map((c, i) => {
          const fill = el('i', { style: `background:${color(idx[res.stats[i].name])}` });
          fill.style.setProperty('--w', c.v == null ? 0 : Math.abs(c.v) / max);
          return el('td', { class: 'val' }, el('div', { class: 'bar' }, el('span', null, core.fmt(c.v, c.fmt)), fill));
        })));
    }
    t.append(tb);
    return el('div', { class: 'scroll' }, t);
  }

  function measuresDrawer(res, idx) {
    // One page means one table: every measure, ranked by how far apart the two
    // people are, rather than five lens-sized subsets of the same list.
    const keys = Object.keys(core.METRICS)
      // A clock-derived measure on an undated transcript would be a number about a
      // timeline this page made up a moment ago.
      .filter(k => !(res.undated && core.METRICS[k].needsTime));
    const ranked = keys.slice().sort((a, b) => diffScore(res, b) - diffScore(res, a));
    const top = ranked.slice(0, TOP_DIFFS), rest = ranked.slice(TOP_DIFFS);

    const panel = el('div', { class: 'panel' });
    const head = el('div', { class: 'panel-head' },
      el('div', null,
        el('h3', null, 'Where you differ most'),
        el('p', { class: 'sub' }, 'The widest gaps in this lens. Same counting rules for everyone; bars compare across each row.')));

    // Both views of the same numbers, in the same container, rather than a rate in
    // one place and a count somewhere else.
    const body = el('div');
    const draw = () => {
      body.textContent = '';
      body.append(measuresTable(res, top, idx, state.totals));
      if (rest.length) {
        body.append(el('details', null,
          el('summary', null, `Show the other ${rest.length} measure${rest.length === 1 ? '' : 's'}`),
          measuresTable(res, rest, idx, state.totals)));
      }
    };
    const seg = el('div', { class: 'seg tiny', role: 'group', 'aria-label': 'How to count' });
    const btns = [['Per 100 words', false], ['Totals', true]].map(([label, isTotals]) =>
      el('button', {
        type: 'button', 'aria-pressed': String(state.totals === isTotals),
        onclick: () => {
          if (state.totals === isTotals) return;
          state.totals = isTotals;
          for (const b of btns) b.setAttribute('aria-pressed', String(b.dataset.totals === String(state.totals)));
          draw();
        },
      }, label));
    btns.forEach((b, i) => { b.dataset.totals = String(!!i); seg.append(b); });
    head.append(seg);

    panel.append(head, body);
    draw();
    return panel;
  }

  /* ---------------------------------------------------------------- charts */

  /**
   * Gridlines for a y axis: a round step, a top that is a multiple of it, and a
   * sensible number of lines.
   *
   * Two things were wrong before. The ladder was 1/2/2.5/5/10, so a 120-message
   * peak drew an axis to 200 and the data sat in the bottom half. And the top was
   * always divided into four, so an axis to 5 put a gridline at 2.5 and labelled it
   * "3". Here the step is what gets rounded, so every label is exact, and the
   * candidate that wastes least headroom wins.
   */
  function axisTicks(max) {
    if (!(max > 0)) return { top: 1, step: 0.25 };
    const p = Math.pow(10, Math.floor(Math.log10(max)) - 1);
    let best = null;
    for (const k of [1, 2, 2.5, 4, 5, 10, 20, 25, 50, 100]) {
      const step = k * p;
      const lines = Math.ceil(max / step);
      if (lines < 3 || lines > 6) continue;
      const top = lines * step;
      if (!best || top < best.top) best = { top, step };
    }
    // Nothing in range (a very flat or very spiky series): fall back to quarters.
    return best || { top: Math.ceil(max * 4) / 4, step: Math.ceil(max * 4) / 16 };
  }
  function shortDay(d) { const [y, mo, da] = d.split('-').map(Number); return new Date(y, mo - 1, da).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }); }

  function lineChart(title, sub, xs, series, idx, fmtV, labelX, opts) {
    const wrap = el('div', { class: 'chart' });
    const legend = el('div', { class: 'legend' }, series.map(s => el('span', null, el('i', { class: 'sw', style: `background:${color(idx[s.name])}` }), s.name)));
    const panel = el('div', { class: 'panel' }, el('h3', null, title), el('p', { class: 'sub' }, sub), legend, wrap);

    const W = 520, H = 200, m = { l: 34, r: 12, t: 10, b: 26 };
    const vals = series.flatMap(s => s.pts).filter(v => v != null);
    const isUnit = vals.every(v => v <= 1);
    const axis = axisTicks(Math.max(...vals, isUnit ? 0.1 : 1));
    const yMax = axis.top;

    /* Where each point sits along the x axis.
     *
     * `opts.at` turns a label into a number — for the day series, a timestamp — so
     * the axis is proportional to real time. Without it, 30 days scattered over
     * three years were drawn evenly spaced, which put a fortnight and an eleven-
     * month silence the same distance apart and made the line meaningless.
     * Ordinal charts (message #1, #2, …) pass nothing and keep even spacing.
     */
    const span = W - m.l - m.r;
    const at = (opts && opts.at) || null;
    let px;
    if (xs.length === 1) px = [m.l + span / 2];
    else if (!at) px = xs.map((_, i) => m.l + (i * span) / (xs.length - 1));
    else {
      const t = xs.map(at);
      const lo = Math.min(...t), hi = Math.max(...t);
      const range = hi - lo;
      px = range > 0 ? t.map(v => m.l + ((v - lo) / range) * span)
        : xs.map((_, i) => m.l + (i * span) / Math.max(xs.length - 1, 1));
    }
    const x = i => px[i];
    const y = v => H - m.b - (v / yMax) * (H - m.t - m.b);
    const svg = sv('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': title });
    const g = sv('g', { class: 'grid' });
    // Labels are the exact gridline value, formatted to the step's own precision,
    // so a line at 2.5 is never labelled "3".
    // Decimals to show: the fewest that still render the step exactly. Counting
    // them off the exponent is wrong for a step like 0.25, which needs two — and
    // getting it wrong is precisely how a gridline at 0.25 came out labelled "0.3".
    let dp = 0;
    while (dp < 8 && Math.abs(Number(axis.step.toFixed(dp)) - axis.step) > 1e-12) dp++;
    for (let v = 0; v <= yMax + 1e-9; v += axis.step) {
      g.append(sv('line', { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v) }));
      const t = sv('text', { x: m.l - 6, y: y(v) + 4, 'text-anchor': 'end' });
      t.textContent = v.toFixed(dp); svg.append(t);
    }
    svg.prepend(g);
    // Labels are spaced by PIXELS, not by index. On a time axis the points bunch up
    // wherever the conversation was busy, and every-Nth-index would stack six labels
    // on top of each other there and leave the quiet stretches bare.
    const MIN_LABEL_GAP = span / 6;
    let lastLabelAt = -Infinity;
    xs.forEach((d, i) => {
      const isLast = i === xs.length - 1;
      if (!isLast && x(i) - lastLabelAt < MIN_LABEL_GAP) return;
      // Never let the last label collide with the one before it.
      if (isLast && x(i) - lastLabelAt < MIN_LABEL_GAP / 2 && xs.length > 1) return;
      lastLabelAt = x(i);
      const t = sv('text', { x: x(i), y: H - 8, 'text-anchor': i === 0 ? 'start' : isLast ? 'end' : 'middle' });
      t.textContent = labelX(d); svg.append(t);
    });
    for (const s of series) {
      const c = color(idx[s.name]);
      let d = '', pen = false, len = 0, px = 0, py = 0;
      s.pts.forEach((v, i) => {
        if (v == null) { pen = false; return; }
        const cx = x(i), cy = y(v);
        if (pen) len += Math.hypot(cx - px, cy - py);
        d += (pen ? 'L' : 'M') + cx.toFixed(1) + ' ' + cy.toFixed(1);
        pen = true; px = cx; py = cy;
      });
      const path = sv('path', { class: 'line', d, fill: 'none', stroke: c, 'stroke-width': 2, 'stroke-linejoin': 'miter', 'stroke-linecap': 'butt' });
      path.style.setProperty('--len', Math.ceil(len) || 1);
      svg.append(path);
      // Square markers, to match the rest of the page.
      if (xs.length <= 45) s.pts.forEach((v, i) => { if (v != null) svg.append(sv('rect', { x: x(i) - 3, y: y(v) - 3, width: 6, height: 6, fill: c })); });
    }
    const cross = sv('line', { y1: m.t, y2: H - m.b, stroke: 'var(--line-strong)', 'stroke-width': 1, visibility: 'hidden' });
    svg.append(cross);
    const hit = sv('rect', { x: m.l, y: m.t, width: W - m.l - m.r, height: H - m.t - m.b, fill: 'transparent' });
    svg.append(hit);
    const tip = el('div', { class: 'tip', hidden: true });
    wrap.append(svg, tip);
    hit.addEventListener('pointermove', ev => {
      const r = svg.getBoundingClientRect();
      const px2 = ((ev.clientX - r.left) / r.width) * W;
      // Nearest point by pixel: with a real time axis the spacing is uneven, so the
      // old linear inversion pointed at the wrong day.
      let i = 0;
      for (let k = 1; k < px.length; k++) if (Math.abs(px[k] - px2) < Math.abs(px[i] - px2)) i = k;
      cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); cross.setAttribute('visibility', 'visible');
      tip.hidden = false;
      tip.textContent = labelX(xs[i]) + ' · ' + series.map(s => `${s.name}: ${s.pts[i] == null ? '—' : fmtV(s.pts[i])}`).join(' · ');
      tip.style.left = Math.min(Math.max((x(i) / W) * r.width, 80), r.width - 80) + 'px';
      tip.style.top = (m.t / H) * r.height + 'px';
    });
    hit.addEventListener('pointerleave', () => { tip.hidden = true; cross.setAttribute('visibility', 'hidden'); });

    const tbl = el('table', null,
      el('thead', null, el('tr', null, el('th', null, 'Point'), series.map(s => el('th', { class: 'num' }, s.name)))),
      el('tbody', null, xs.map((d, i) => el('tr', null, el('td', null, labelX(d)), series.map(s => el('td', { class: 'num' }, s.pts[i] == null ? '—' : fmtV(s.pts[i])))))));
    panel.append(el('details', null, el('summary', null, 'Show as table'), el('div', { class: 'scroll' }, tbl)));
    return panel;
  }

  function chartPanel(res, idx, kind) {
    const titles = {
      heat: ['Heat by day', 'Average hostility heuristic of each person’s messages that day (0–1)'],
      n: ['Messages by day', 'How many each person sent'],
      hours: ['Time of day', 'Messages by hour, all days combined'],
    };
    const [title, sub] = titles[kind];
    if (kind === 'hours') {
      const xs = [...Array(24).keys()].map(h => String(h).padStart(2, '0'));
      return lineChart(title, sub, xs, res.stats.map(s => ({ name: s.name, pts: s.hours.slice() })), idx, v => String(v), d => d + ':00');
    }
    const xs = res.series.map(d => d.day);
    const series = res.people.map(p => ({ name: p, pts: res.series.map(d => (kind === 'heat' ? d.per[p].heat : d.per[p].n)) }));
    // The x axis is real time. `res.series` only carries days that had messages, so
    // spacing them evenly would draw a two-day gap and an eleven-month silence the
    // same width apart.
    const span = res.range.days > 1
      ? `${core.fmtDate(res.range.from)} to ${core.fmtDate(res.range.to)}, spaced by date`
      : null;
    return lineChart(title, span ? sub + ' · ' + span : sub, xs, series, idx,
      v => (kind === 'heat' ? v.toFixed(2) : String(v)), shortDay,
      { at: d => Date.parse(d) });
  }

  function driftPanel(res, idx) {
    const G = res.rigor;
    const byWho = {};
    for (const p of res.people) byWho[p] = [];
    G.drift.forEach(d => { for (const p of res.people) byWho[p].push(d.who === p ? d.drift : null); });
    const xs = G.drift.map((d, i) => i);
    return lineChart('Drift from the opening topic', 'How far each message strays from what the argument started about. 0 is on topic, 1 is a different conversation.',
      xs, res.people.map(p => ({ name: p, pts: byWho[p] })), idx, v => v.toFixed(2), i => '#' + (i + 1));
  }

  /* ----------------------------------------------------------- rigor panels */

  function quoteMeta(idx, who, ...rest) {
    return el('span', { class: 'meta' },
      el('i', { class: 'sw', style: `background:${color(idx[who])}` }),
      el('b', null, who),
      rest.filter(Boolean).map(x => el('span', null, x)));
  }

  function claimLedger(res, idx) {
    const G = res.rigor;
    const SHOWN = 12;
    // No "When" column on an undated transcript: the only date available is the one
    // the parser invented to keep the ordering working.
    const dated = !res.undated;
    const row = c => el('tr', null,
      el('td', null, el('i', { class: 'sw', style: `background:${color(idx[c.who])};display:inline-block;margin-right:6px` }), c.who),
      dated ? el('td', { class: 'muted' }, core.fmtDate(c.date)) : null,
      el('td', { class: 'claimtext' }, c.text),
      el('td', null, el('span', { class: 'tag ' + c.status }, c.status)),
      el('td', { class: 'num' }, c.challenged ? 'yes' : '—'),
      el('td', { class: 'num' }, c.answered ? 'yes' : c.challenged ? 'no' : '—'));
    const head = () => el('thead', null, el('tr', null,
      el('th', null, 'Who'), dated ? el('th', null, 'When') : null, el('th', null, 'Claim'),
      el('th', null, 'Status'), el('th', { class: 'num' }, 'Challenged'), el('th', { class: 'num' }, 'Backed up')));
    const total = G.ledgerTotal != null ? G.ledgerTotal : G.ledger.length;
    const panel = el('div', { class: 'panel' },
      el('h3', null, 'Claim ledger'),
      el('p', { class: 'sub' }, `Every factual-sounding sentence, and whether it pointed at anything checkable. Threadlens never marks a claim true or false — that part is still your job. ${total.toLocaleString()} found${total > G.ledger.length ? `, showing the first ${G.ledger.length}` : ''}.`),
      el('div', { class: 'scroll' }, el('table', null, head(), el('tbody', null, G.ledger.slice(0, SHOWN).map(row)))));
    if (G.ledger.length > SHOWN) {
      panel.append(el('details', null,
        el('summary', null, `Show all ${G.ledger.length.toLocaleString()}`),
        el('div', { class: 'scroll' }, el('table', null, head(), el('tbody', null, G.ledger.slice(SHOWN).map(row))))));
    }
    return panel;
  }

  function unansweredPanel(res, idx) {
    const G = res.rigor;
    const total = G.unansweredTotal != null ? G.unansweredTotal : G.unanswered.length;
    const panel = el('div', { class: 'panel' },
      el('h3', null, 'Questions nobody answered'),
      el('p', { class: 'sub' }, `Direct questions that got no engaging reply within the next 6 messages. ${total.toLocaleString()} of them.`));
    if (!G.unanswered.length) { panel.append(el('p', { class: 'muted' }, 'Every question got a reply. That is genuinely rare.')); return panel; }
    panel.append(el('div', { class: 'quotes' }, G.unanswered.slice(0, 8).map(q =>
      el('div', { class: 'quote' }, quoteMeta(idx, q.who, res.undated ? null : core.fmtDate(q.date)), el('p', null, q.text)))));
    return panel;
  }

  /* ---------------------------------------------------------- other panels */

  function moralPanel(res, idx) {
    const t = el('table', null,
      el('thead', null, el('tr', null, el('th', null, 'Foundation'), res.stats.map(s => el('th', { class: 'num' }, s.name)))),
      el('tbody', null, Object.keys(core.MORAL_LABELS).map(k => {
        const vals = res.stats.map(s => s.moral[k] || 0); const max = Math.max(...vals, 1e-9);
        return el('tr', null, el('th', { scope: 'row' }, core.MORAL_LABELS[k]),
          res.stats.map((s, i) => {
            const fill = el('i', { style: `background:${color(idx[s.name])}` });
            fill.style.setProperty('--w', vals[i] / max);
            return el('td', { class: 'val' }, el('div', { class: 'bar' }, el('span', null, vals[i].toFixed(2)), fill));
          }));
      })));
    return el('div', { class: 'panel' }, el('h3', null, 'Moral vocabulary'), el('p', { class: 'sub' }, 'Words per 100 tied to each foundation. People arguing from different foundations tend to talk past each other.'), el('div', { class: 'scroll' }, t));
  }

  function rhetoricPanel(res, idx) {
    const t = el('table', null,
      el('thead', null, el('tr', null, el('th', null, 'Cue'), res.stats.map(s => el('th', { class: 'num' }, s.name)))),
      el('tbody', null, Object.keys(core.RHET_LABELS).map(k => el('tr', null, el('th', { scope: 'row' }, core.RHET_LABELS[k]), res.stats.map(s => el('td', { class: 'num' }, String(s.rhetoric[k] || 0)))))));
    const panel = el('div', { class: 'panel' }, el('h3', null, 'Rhetorical cues'), el('p', { class: 'sub' }, 'Phrase matches, not verdicts. Open the examples and judge them in context.'), el('div', { class: 'scroll' }, t));
    if ($('#showq').checked) {
      const ex = el('div', { class: 'quotes' });
      for (const s of res.stats) for (const k in s.examples) for (const q of s.examples[k].slice(0, 2))
        ex.append(el('div', { class: 'quote' }, quoteMeta(idx, s.name, core.RHET_LABELS[k], res.undated ? null : dateTime(q.date)), el('p', null, q.text)));
      if (ex.childElementCount) panel.append(el('details', null, el('summary', null, 'Show matched messages'), ex));
    }
    return panel;
  }

  function hottestPanel(res, idx) {
    return el('div', { class: 'panel' }, el('h3', null, 'Hottest messages'), el('p', { class: 'sub' }, 'Highest heat scores. Check whether the words were meant, quoted or joking.'),
      el('div', { class: 'quotes' }, res.hottest.map(h => el('div', { class: 'quote' },
        quoteMeta(idx, h.who, res.undated ? null : dateTime(h.date), 'heat ' + h.heat.toFixed(2)), el('p', null, h.text)))));
  }

  /* --------------------------------------------------------------- wiring */

  /* ------------------------------------------------------ headline carousel
   * Every question here is one the report genuinely answers, so the headline is a
   * table of contents rather than a slogan. The pairing matters: if a question is
   * added without a panel behind it, the page starts promising something it does
   * not deliver.
   */
  const HERO_QUESTIONS = [
    ['Who actually ', 'started', ' it?'],                  // episodes, who opens after a 6h gap
    ['Do you even speak the same ', 'language', '?'],      // code-switching + shared vocabulary
    ['Which of you brings ', 'receipts', '?'],             // sourcing, the claim ledger
    ['Who actually ', 'answers', ' the question?'],        // responsiveness, unanswered questions
    ['Whose ', 'temper', ' turns up first?'],              // the heat curve
    ['Are you even arguing about the same ', 'thing', '?'], // drift from the opening topic
  ];
  const HERO_DWELL_MS = 5200;
  const HERO_DRAG_PX = 48;     // how far a drag must travel to count as a swipe

  function heroCarousel() {
    const box = $('#h1');
    if (!box || !box.hasAttribute('data-rotator')) return;

    const slides = HERO_QUESTIONS.map(([before, word, after], i) => {
      const line = el('span', { class: 'rot-line' + (i ? '' : ' is-on') },
        before, el('em', null, word), after);
      return line;
    });
    box.textContent = '';
    box.append(...slides);
    box.classList.add('is-live');

    // Reserve the tallest slide's height once, so nothing below the headline moves
    // as the questions change length.
    const settle = () => {
      box.style.minHeight = '';
      const tallest = Math.max(...slides.map(s => {
        const was = s.className;
        s.className = 'rot-line is-on';
        const h = s.getBoundingClientRect().height;
        s.className = was;
        return h;
      }));
      if (tallest) box.style.minHeight = Math.ceil(tallest) + 'px';
    };
    settle();
    addEventListener('resize', settle);

    const tick = el('span', { class: 'rot-tick', 'aria-hidden': 'true' }, el('i'));
    box.after(tick);
    const fill = tick.firstElementChild;

    let at = 0, timer = null, raf = null, startedAt = 0, held = false;

    const show = (next, dir) => {
      next = (next + slides.length) % slides.length;
      if (next === at) return;
      box.style.setProperty('--slide-from', (dir < 0 ? -1 : 1) * 1.5 + 'rem');
      slides[at].classList.remove('is-on');
      slides[at].classList.add('is-out');
      const leaving = slides[at];
      setTimeout(() => leaving.classList.remove('is-out'), 500);
      at = next;
      slides[at].classList.add('is-on');
    };

    const stop = () => { clearTimeout(timer); cancelAnimationFrame(raf); timer = raf = null; fill.style.setProperty('--p', 0); };
    const run = () => {
      if (reduceMotion() || held) return;
      stop();
      startedAt = performance.now();
      const step = now => {
        const p = Math.min(1, (now - startedAt) / HERO_DWELL_MS);
        fill.style.setProperty('--p', p);
        if (p < 1) raf = requestAnimationFrame(step);
      };
      raf = requestAnimationFrame(step);
      timer = setTimeout(() => { show(at + 1, 1); run(); }, HERO_DWELL_MS);
    };

    // Hold to pause, drag sideways to move. No arrows, no dots: the gesture is the
    // control, and the hairline is the only thing that hints there is more.
    let downX = null;
    box.addEventListener('pointerdown', e => {
      downX = e.clientX; held = true;
      box.classList.add('is-held');
      box.setPointerCapture(e.pointerId);
      stop();
    });
    box.addEventListener('pointerup', e => {
      box.classList.remove('is-held');
      held = false;
      if (downX != null) {
        const dx = e.clientX - downX;
        if (Math.abs(dx) >= HERO_DRAG_PX) show(at + (dx < 0 ? 1 : -1), dx < 0 ? 1 : -1);
      }
      downX = null;
      run();
    });
    box.addEventListener('pointercancel', () => { box.classList.remove('is-held'); held = false; downX = null; run(); });
    // Keyboard and assistive technology get the same control the gesture gives.
    box.tabIndex = 0;
    box.setAttribute('aria-roledescription', 'carousel');
    box.addEventListener('keydown', e => {
      if (e.key === 'ArrowRight') { show(at + 1, 1); run(); }
      else if (e.key === 'ArrowLeft') { show(at - 1, -1); run(); }
    });
    // Nothing should animate in a tab nobody is looking at.
    document.addEventListener('visibilitychange', () => (document.hidden ? stop() : run()));
    run();
  }
  heroCarousel();

  const zone = $('#zone'), file = $('#file');
  $('#pick').addEventListener('click', e => { e.stopPropagation(); file.click(); });
  zone.addEventListener('click', e => { if (e.target === zone || e.target.closest('strong,.formats')) file.click(); });
  zone.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && e.target === zone) { e.preventDefault(); file.click(); } });
  file.addEventListener('change', () => { const f = file.files[0]; if (f) { showFileCard(f.name, f.size); ingest(() => readFile(f), f.name); } });
  ['dragenter', 'dragover'].forEach(t => zone.addEventListener(t, e => { e.preventDefault(); zone.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(t => zone.addEventListener(t, e => { e.preventDefault(); zone.classList.remove('over'); }));
  zone.addEventListener('drop', e => { const f = e.dataTransfer.files[0]; if (f) { showFileCard(f.name, f.size); ingest(() => readFile(f), f.name); } });
  $('#paste-toggle').addEventListener('click', e => { e.stopPropagation(); const b = $('#paste-box'); b.hidden = !b.hidden; if (!b.hidden) $('#paste').focus(); });
  $('#paste-go').addEventListener('click', () => {
    const t = $('#paste').value;
    if (!t.trim()) return showError('Paste the exported chat text first.');
    showFileCard('Pasted text', t.length);
    ingest(async () => t, 'Pasted conversation');
  });
  $('#load-sample').addEventListener('click', e => { e.stopPropagation(); ingest(async () => SAMPLE, 'Sample', true); });
  document.addEventListener('paste', e => {
    if (e.target.closest && e.target.closest('textarea,input')) return;
    const t = e.clipboardData && e.clipboardData.getData('text');
    // Either a clock, or at least two "Name: message" lines — a transcript copied
    // off a screen has no timestamps and used to be ignored here.
    const looksLikeChat = /\d[:.]\d{2}/.test(t || '') || (t || '').split('\n').filter(l => /^[^:\n]{1,40}:\s+\S/.test(l)).length >= 2;
    if (t && looksLikeChat) { showFileCard('Pasted text', t.length); ingest(async () => t, 'Pasted conversation'); }
  });
  ['#anon', '#order'].forEach(s => $(s).addEventListener('change', rerun));
  // The relationship reorders the section nav and nothing else.
  $('#relation').addEventListener('change', () => { if (state.res) render(); });
  $('#showq').addEventListener('change', () => { if (state.res) render(); });
  // A section can be deep-linked. The old lens names still work as anchors, so a
  // link to #rigor from anywhere keeps landing on the right part of the report.
  const LEGACY_ANCHOR = { rigor: 'rigor', debate: 'tone', overview: 'summary', personal: 'tone', work: 'timeline' };
  const fromHash = location.hash.slice(1);
  if (LEGACY_ANCHOR[fromHash]) {
    addEventListener('load', () => {
      const t = $('#sec-' + LEGACY_ANCHOR[fromHash]);
      if (t) t.scrollIntoView({ behavior: 'auto', block: 'start' });
    }, { once: true });
  }

  // Open in a working state: the synthetic sample, clearly labelled as such.
  ingest(async () => SAMPLE, 'Sample', true);
})();
