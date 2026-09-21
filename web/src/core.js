/*! Threadlens core — parsing + scoring. MIT License. Runs in the browser and in Node; makes no network calls. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ThreadlensCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------------------------------------------------------------- parsing */

  const INVISIBLE = /[\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;
  const ANDROID = /^(\d{1,4})[./-](\d{1,2})[./-](\d{1,4}),?\s+(\d{1,2})[:.](\d{2})(?:[:.](\d{2}))?\s*([AaPp]\.?\s?[Mm]\.?)?\s*[-–]\s(.*)$/;
  const IOS = /^\[(\d{1,4})[./-](\d{1,2})[./-](\d{1,4}),?\s+(\d{1,2})[:.](\d{2})(?:[:.](\d{2}))?\s*([AaPp]\.?\s?[Mm]\.?)?\]\s?(.*)$/;
  const MEDIA = /^(<media omitted>|<attached:.*>|(image|video|audio|sticker|gif|document|contact card) omitted|null)$/i;
  const DELETED = /^(this message was deleted|you deleted this message|message deleted)$/i;
  const EDITED = /\s*<this message was edited>\s*$/i;

  function cleanLine(l) {
    return l.replace(INVISIBLE, '').replace(/[\u202f\u00a0]/g, ' ').replace(/\r$/, '');
  }

  /** Split raw export text into header matches + continuation lines. */
  function tokenizeLines(text) {
    const lines = text.split(/\n/).map(cleanLine);
    const out = [];
    for (const line of lines) {
      const m = line.match(IOS) || line.match(ANDROID);
      if (m) out.push({ head: m, rest: m[8] });
      else if (out.length) out[out.length - 1].rest += '\n' + line;
    }
    return out;
  }

  function detectDateOrder(heads) {
    let dmy = 0, mdy = 0, ymd = 0;
    for (const h of heads) {
      const a = +h[1], b = +h[2];
      if (h[1].length === 4) ymd++;
      else if (a > 12) dmy++;
      else if (b > 12) mdy++;
    }
    if (ymd > heads.length / 2) return 'YMD';
    if (mdy > dmy) return 'MDY';
    return 'DMY';
  }

  function toDate(h, order) {
    let d, mo, y;
    if (order === 'YMD') { y = +h[1]; mo = +h[2]; d = +h[3]; }
    else if (order === 'MDY') { mo = +h[1]; d = +h[2]; y = +h[3]; }
    else { d = +h[1]; mo = +h[2]; y = +h[3]; }
    if (y < 100) y += 2000;
    let hr = +h[4];
    const mi = +h[5], se = h[6] ? +h[6] : 0;
    const ap = h[7] ? h[7].replace(/[.\s]/g, '').toLowerCase() : '';
    if (ap === 'pm' && hr < 12) hr += 12;
    if (ap === 'am' && hr === 12) hr = 0;
    const dt = new Date(y, mo - 1, d, hr, mi, se);
    return isNaN(dt.getTime()) ? null : dt;
  }

  /**
   * Parse a WhatsApp export (Android or iOS, 12h or 24h, any locale separator).
   * @param {string} text
   * @param {{dateOrder?: 'auto'|'DMY'|'MDY'|'YMD'}} [opts]
   */
  function parseChat(text, opts) {
    opts = opts || {};
    const rows = tokenizeLines(String(text || ''));
    const order = !opts.dateOrder || opts.dateOrder === 'auto' ? detectDateOrder(rows.map(r => r.head)) : opts.dateOrder;
    const messages = [];
    let system = 0;
    for (const r of rows) {
      const date = toDate(r.head, order);
      if (!date) continue;
      const rest = r.rest;
      const idx = rest.indexOf(': ');
      const nameCand = idx > 0 ? rest.slice(0, idx) : '';
      if (idx <= 0 || nameCand.length > 60 || /\n/.test(nameCand)) { system++; continue; }
      let body = rest.slice(idx + 2).trim();
      const edited = EDITED.test(body);
      body = body.replace(EDITED, '').trim();
      const kind = MEDIA.test(body) ? 'media' : DELETED.test(body) ? 'deleted' : 'text';
      messages.push({ date, author: nameCand.trim(), text: kind === 'text' ? body : '', kind, edited });
    }
    return { messages, dateOrder: order, systemLines: system };
  }

  /* -------------------------------------------------------------- lexicons */

  function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  const IS_WORDCHAR = /[\p{L}\p{N}']/u;

  /** Compile a word list into {words:Set, phrases:[RegExp], emoji:[str]}. */
  function compileList(list, isRegex) {
    const words = new Set(), phrases = [], emoji = [];
    for (const raw of list) {
      const w = raw.toLowerCase();
      if (isRegex) { phrases.push(new RegExp('(?:^|[^\\p{L}])' + w + '(?![\\p{L}])', 'giu')); continue; }
      if (!IS_WORDCHAR.test(w)) emoji.push(w);
      else if (/[\s-]/.test(w)) phrases.push(new RegExp('(?:^|[^\\p{L}])' + escapeRe(w) + '(?![\\p{L}])', 'giu'));
      else words.add(w);
    }
    return { words, phrases, emoji };
  }

  function countList(c, tokens, lower) {
    let n = 0;
    if (c.words.size) for (const t of tokens) if (c.words.has(t)) n++;
    for (const re of c.phrases) { re.lastIndex = 0; const m = lower.match(re); if (m) n += m.length; }
    for (const e of c.emoji) n += lower.split(e).length - 1;
    return n;
  }

  function tokenize(lower) { return lower.match(/[\p{L}\p{N}']+/gu) || []; }

  /* -------------------------------------------------------------- sentiment */

  const NEGATORS = new Set(['not', 'no', 'never', 'nahi', 'nahin', 'na', "don't", 'dont', "isn't", 'isnt', "wasn't", "can't", 'cant', "won't", 'without']);
  function sentiment(tokens, vader) {
    let s = 0;
    for (let i = 0; i < tokens.length; i++) {
      let v = vader[tokens[i]];
      if (v === undefined) continue;
      for (let j = Math.max(0, i - 3); j < i; j++) if (NEGATORS.has(tokens[j])) { v *= -0.74; break; }
      s += v;
    }
    return s / Math.sqrt(s * s + 15);
  }

  /* --------------------------------------------------------------- analysis */

  const MIN_WORDS_FOR_CLAIM = 150;
  const GAP_HOURS_FOR_INITIATION = 6;

  function median(a) { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
  function mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; }
  function dayKey(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }

  /**
   * @param {object} lex  lexicons.json
   * @param {object} vader  vader.json
   */
  function createAnalyzer(lex, vader) {
    const L = {};
    for (const k of Object.keys(lex)) {
      if (k.startsWith('_') || k === 'moral' || k === 'rhetoric') continue;
      L[k] = compileList(lex[k]);
    }
    const MORAL = {}; for (const k of Object.keys(lex.moral)) MORAL[k] = compileList(lex.moral[k]);
    const RHET = {}; for (const k of Object.keys(lex.rhetoric)) RHET[k] = compileList(lex.rhetoric[k], true);

    function scoreMessage(m) {
      const lower = m.text.toLowerCase();
      const tokens = tokenize(lower);
      const c = {};
      for (const k of Object.keys(L)) c[k] = countList(L[k], tokens, lower);
      const moral = {}; for (const k of Object.keys(MORAL)) moral[k] = countList(MORAL[k], tokens, lower);
      const rhet = {}; for (const k of Object.keys(RHET)) rhet[k] = countList(RHET[k], tokens, lower);
      const capsWords = (m.text.match(/\b[A-Z]{3,}\b/g) || []).length;
      const questions = (m.text.match(/\?/g) || []).length > 0 ? 1 : 0;
      // Heat: a transparent hostility heuristic (0..1). Weighted hits, damped by message length.
      const raw = c.profanity * 1 + c.insult * 1 + c.political_label * 0.6 + c.status_hierarchy * 0.4 +
        rhet.personal_attack * 1.2 + c.mock * 0.3 + (tokens.length > 3 && capsWords / tokens.length > 0.5 ? 0.5 : 0);
      const heat = raw ? 1 - Math.exp(-raw * 3 / Math.sqrt(Math.max(tokens.length, 6))) : 0;
      return { words: tokens.length, c, moral, rhet, capsWords, questions, heat, sent: sentiment(tokens, vader) };
    }

    /**
     * Analyse parsed messages.
     * @param {{messages: Array}} parsed
     * @param {{anonymise?: boolean, maxPeople?: number}} [opts]
     */
    function analyse(parsed, opts) {
      opts = opts || {};
      const msgs = parsed.messages.slice().sort((a, b) => a.date - b.date);
      if (!msgs.length) throw new Error('No messages found. Check that this is a WhatsApp chat export (.txt, .zip or .docx).');

      // participants, ordered by message count (colour follows this order and never changes afterwards)
      const counts = {};
      for (const m of msgs) counts[m.author] = (counts[m.author] || 0) + 1;
      let names = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
      const maxPeople = opts.maxPeople || 8;
      const alias = {};
      names.forEach((n, i) => { alias[n] = opts.anonymise ? 'Person ' + String.fromCharCode(65 + i) : n; });
      const others = names.length > maxPeople;
      const label = n => (names.indexOf(n) >= maxPeople ? 'Others' : alias[n]);
      const people = [...new Set(names.map(label))];

      const P = {};
      for (const p of people) P[p] = {
        name: p, messages: 0, textMessages: 0, words: 0, media: 0, deleted: 0, edited: 0,
        c: {}, moral: {}, rhet: {}, capsWords: 0, questions: 0, heat: [], sent: [],
        replyMins: [], initiations: 0, hours: new Array(24).fill(0), examples: {}, lastExit: null, reentries: [],
      };

      const byDay = {};
      let prev = null;
      const scored = [];
      for (const m of msgs) {
        const who = label(m.author);
        const p = P[who];
        p.messages++;
        p.hours[m.date.getHours()]++;
        if (m.kind === 'media') p.media++;
        if (m.kind === 'deleted') p.deleted++;
        if (m.edited) p.edited++;
        const gapH = prev ? (m.date - prev.date) / 36e5 : Infinity;
        if (gapH >= GAP_HOURS_FOR_INITIATION) p.initiations++;
        else if (prev && label(prev.author) !== who) p.replyMins.push((m.date - prev.date) / 6e4);
        prev = m;

        const dk = dayKey(m.date);
        byDay[dk] = byDay[dk] || {};
        byDay[dk][who] = byDay[dk][who] || { n: 0, heat: [], sent: [] };
        byDay[dk][who].n++;
        if (m.kind !== 'text') continue;

        const s = scoreMessage(m);
        scored.push({ who, date: m.date, text: m.text, ...s });
        p.textMessages++;
        p.words += s.words;
        p.capsWords += s.capsWords;
        p.questions += s.questions;
        p.heat.push(s.heat); p.sent.push(s.sent);
        byDay[dk][who].heat.push(s.heat); byDay[dk][who].sent.push(s.sent);
        for (const k in s.c) p.c[k] = (p.c[k] || 0) + s.c[k];
        for (const k in s.moral) p.moral[k] = (p.moral[k] || 0) + s.moral[k];
        for (const k in s.rhet) {
          if (!s.rhet[k]) continue;
          p.rhet[k] = (p.rhet[k] || 0) + s.rhet[k];
          (p.examples[k] = p.examples[k] || []).length < 3 && p.examples[k].push({ date: m.date, text: m.text.slice(0, 220) });
        }
        if (s.rhet.exit_or_concession) p.lastExit = m.date;
        else if (p.lastExit && s.words >= 60 && (m.date - p.lastExit) > 36e5) {
          p.reentries.push({ exit: p.lastExit, back: m.date, words: s.words });
          p.lastExit = null;
        }
      }

      // per-100-word rates
      const per100 = (p, n) => (p.words ? (100 * n) / p.words : 0);
      const stats = people.map(n => {
        const p = P[n];
        const rate = k => per100(p, p.c[k] || 0);
        const third = Math.max(1, Math.floor(p.heat.length / 3));
        return {
          name: n,
          messages: p.messages, textMessages: p.textMessages, words: p.words,
          wordsPerMsg: p.textMessages ? p.words / p.textMessages : 0,
          share: p.messages / msgs.length,
          questionRate: p.textMessages ? p.questions / p.textMessages : 0,
          absolutist: rate('absolutist'), hedge: rate('hedge'), self: rate('self'), other: rate('other'), we: rate('we'),
          evidence: rate('evidence'), politeness: rate('politeness'), affection: rate('affection'), apology: rate('apology'),
          urgency: rate('urgency'), action: rate('action'), profanity: rate('profanity'), insult: rate('insult'),
          politicalLabel: rate('political_label'), status: rate('status_hierarchy'),
          laugh: p.c.laugh || 0, mock: p.c.mock || 0, caps: per100(p, p.capsWords),
          moral: Object.fromEntries(Object.keys(p.moral).map(k => [k, per100(p, p.moral[k])])),
          rhetoric: { ...p.rhet }, examples: p.examples, reentries: p.reentries,
          heatMean: mean(p.heat), heatFirst: mean(p.heat.slice(0, third)), heatLast: mean(p.heat.slice(-third)),
          hotMessages: p.heat.filter(h => h >= 0.5).length,
          sentiment: mean(p.sent),
          replyMedianMin: median(p.replyMins), replyCount: p.replyMins.length,
          initiations: p.initiations, media: p.media, deleted: p.deleted, edited: p.edited,
          afterHours: p.messages ? p.hours.filter((_, h) => h < 9 || h >= 21).reduce((a, b) => a + b, 0) / p.messages : 0,
          hours: p.hours,
        };
      });

      const days = Object.keys(byDay).sort();
      const series = days.map(d => ({
        day: d,
        per: Object.fromEntries(people.map(n => {
          const x = byDay[d][n];
          return [n, x ? { n: x.n, heat: x.heat.length ? mean(x.heat) : null, sent: x.sent.length ? mean(x.sent) : null } : { n: 0, heat: null, sent: null }];
        })),
      }));

      const hottest = scored.filter(s => s.heat >= 0.5).sort((a, b) => b.heat - a.heat).slice(0, 6)
        .map(s => ({ who: s.who, date: s.date, heat: s.heat, text: s.text.slice(0, 240) }));

      return {
        people, stats, series, hottest, others,
        range: { from: msgs[0].date, to: msgs[msgs.length - 1].date, days: days.length },
        totals: { messages: msgs.length, words: stats.reduce((a, s) => a + s.words, 0) },
        dateOrder: parsed.dateOrder,
      };
    }

    return { analyse, scoreMessage };
  }

  /* --------------------------------------------------------------- findings */

  const LENSES = {
    overview: { title: 'Overview', blurb: 'Who talks, when, how much, and in what tone.' },
    debate: { title: 'Debate', blurb: 'How an argument was conducted: questions vs. assertions, evidence, labels, escalation.' },
    personal: { title: 'Personal', blurb: 'Balance and warmth: who reaches out, who replies, affection and apology.' },
    work: { title: 'Work', blurb: 'Responsiveness and clarity: reply times, action words, politeness, after-hours load.' },
  };

  const METRICS = {
    share: { label: 'Share of messages', fmt: 'pct', lenses: ['overview', 'personal', 'work'] },
    wordsPerMsg: { label: 'Words per message', fmt: 'num1', lenses: ['overview', 'debate'] },
    questionRate: { label: 'Messages that ask a question', fmt: 'pct', lenses: ['overview', 'debate', 'personal', 'work'] },
    absolutist: { label: 'Absolutist words', fmt: 'rate', lenses: ['debate'], note: 'always, never, every, nothing, simple…' },
    hedge: { label: 'Hedging words', fmt: 'rate', lenses: ['debate'], note: 'maybe, I think, probably…' },
    evidence: { label: 'Evidence words', fmt: 'rate', lenses: ['debate', 'work'], note: 'source, proof, court, data…' },
    self: { label: '“I / me / my”', fmt: 'rate', lenses: ['debate', 'personal'] },
    other: { label: '“You / your”', fmt: 'rate', lenses: ['debate', 'personal'] },
    we: { label: '“We / us”', fmt: 'rate', lenses: ['personal', 'work'] },
    politicalLabel: { label: 'Group labels', fmt: 'rate', lenses: ['debate'], note: 'bhakt, libtard, anti-national…' },
    status: { label: 'Status / age put-downs', fmt: 'rate', lenses: ['debate'], note: 'kid, chote, grow up…' },
    profanity: { label: 'Profanity', fmt: 'rate', lenses: ['overview', 'debate'] },
    insult: { label: 'Insults', fmt: 'rate', lenses: ['debate', 'personal'] },
    laugh: { label: 'Laughing emoji / lol', fmt: 'int', lenses: ['overview', 'debate'] },
    mock: { label: 'Mocking emoji / phrases', fmt: 'int', lenses: ['debate'] },
    heatMean: { label: 'Heat (hostility heuristic)', fmt: 'num2', lenses: ['overview', 'debate', 'personal'] },
    sentiment: { label: 'Average tone (VADER)', fmt: 'signed2', lenses: ['overview', 'personal'] },
    affection: { label: 'Affection words', fmt: 'rate', lenses: ['personal'] },
    apology: { label: 'Apologies', fmt: 'rate', lenses: ['personal', 'work'] },
    politeness: { label: 'Please / thanks', fmt: 'rate', lenses: ['work', 'personal'] },
    action: { label: 'Action words', fmt: 'rate', lenses: ['work'] },
    urgency: { label: 'Urgency words', fmt: 'rate', lenses: ['work'] },
    initiations: { label: 'Conversations started', fmt: 'int', lenses: ['overview', 'personal', 'work'], note: 'first message after a 6h gap' },
    replyMedianMin: { label: 'Median reply time', fmt: 'mins', lenses: ['overview', 'personal', 'work'] },
    afterHours: { label: 'Sent before 9am / after 9pm', fmt: 'pct', lenses: ['work', 'personal'] },
  };

  const MORAL_LABELS = { care: 'Care / harm', fairness: 'Fairness / justice', loyalty: 'Loyalty / nation', authority: 'Authority / respect', purity: 'Purity / disgust' };
  const RHET_LABELS = {
    whataboutism: 'Whataboutism', false_dilemma: 'False choice', exit_or_concession: 'Exit or concession',
    unfalsifiable: 'Unfalsifiable certainty', evidence_request: 'Asks for evidence', personal_attack: 'Personal attack',
  };

  function ratio(a, b) { return b > 0 ? a / b : a > 0 ? Infinity : 1; }

  /** Plain-language findings. Symmetric: every comparison names both sides and the size of the gap. */
  function findings(res, lens) {
    const out = [];
    const S = res.stats.filter(s => s.name !== 'Others');
    const enough = S.filter(s => s.words >= MIN_WORDS_FOR_CLAIM);
    if (enough.length < 2) {
      out.push({ kind: 'caveat', text: 'Fewer than two people wrote ' + MIN_WORDS_FOR_CLAIM + '+ words, so comparisons are switched off. Numbers below are descriptive only.' });
      return out;
    }
    const [a, b] = enough.slice(0, 2);
    const cmp = (key, phrase, min) => {
      const va = a[key], vb = b[key];
      if (Math.max(va, vb) < (min || 0.3)) return;
      const r = ratio(Math.max(va, vb), Math.min(va, vb));
      if (r < 1.4) return;
      const hi = va > vb ? a : b, lo = va > vb ? b : a;
      out.push({ kind: 'compare', text: `${hi.name} ${phrase} ${r === Infinity ? 'where ' + lo.name + ' uses none' : r.toFixed(1) + '× as often as ' + lo.name}.` });
    };
    const lensCmp = {
      overview: [['questionRate', 'asks questions', 0.05], ['profanity', 'swears'], ['wordsPerMsg', 'writes long messages', 3]],
      debate: [['questionRate', 'asks questions', 0.05], ['absolutist', 'uses absolutist words'], ['evidence', 'uses evidence words'], ['politicalLabel', 'uses group labels', 0.1], ['status', 'uses status put-downs', 0.1], ['insult', 'uses insults', 0.1], ['profanity', 'swears', 0.1]],
      personal: [['affection', 'uses affectionate words', 0.2], ['apology', 'apologises', 0.1], ['questionRate', 'asks questions', 0.05], ['other', 'addresses the other person directly']],
      work: [['politeness', 'says please/thanks'], ['action', 'uses action words'], ['urgency', 'uses urgency words', 0.2], ['evidence', 'refers to data/sources', 0.2]],
    }[lens] || [];
    for (const c of lensCmp) cmp(c[0], c[1], c[2]);

    if (lens === 'personal' || lens === 'work' || lens === 'overview') {
      const tot = a.initiations + b.initiations;
      if (tot >= 4) {
        const hi = a.initiations >= b.initiations ? a : b;
        const share = hi.initiations / tot;
        if (share >= 0.65) out.push({ kind: 'compare', text: `${hi.name} starts ${Math.round(share * 100)}% of conversations (${hi.initiations} of ${tot}).` });
      }
      if (a.replyMedianMin != null && b.replyMedianMin != null && a.replyCount >= 5 && b.replyCount >= 5) {
        const r = ratio(Math.max(a.replyMedianMin, b.replyMedianMin), Math.min(a.replyMedianMin, b.replyMedianMin) || 0.5);
        if (r >= 2) {
          const slow = a.replyMedianMin > b.replyMedianMin ? a : b, fast = slow === a ? b : a;
          out.push({ kind: 'compare', text: `${fast.name} replies faster: a median of ${fmtMins(fast.replyMedianMin)} against ${slow.name}'s ${fmtMins(slow.replyMedianMin)}.` });
        }
      }
    }
    if (lens === 'debate' || lens === 'overview' || lens === 'personal') {
      for (const s of enough.slice(0, 2)) {
        if (s.heatLast > 0.12 && s.heatLast >= 2 * Math.max(s.heatFirst, 0.03))
          out.push({ kind: 'trend', text: `${s.name}'s heat rose from ${s.heatFirst.toFixed(2)} in their first third of messages to ${s.heatLast.toFixed(2)} in their last third.` });
      }
    }
    if (lens === 'debate') {
      for (const s of enough.slice(0, 2)) for (const r of s.reentries.slice(0, 2))
        out.push({ kind: 'pattern', text: `${s.name} signalled an exit (“agree to disagree”, “you won”…) on ${fmtDate(r.exit)}, then returned with a ${r.words}-word message on ${fmtDate(r.back)}.` });
      const ma = topMoral(a), mb = topMoral(b);
      if (ma && mb && ma !== mb) out.push({ kind: 'pattern', text: `Different moral vocabularies: ${a.name} leans on ${MORAL_LABELS[ma].toLowerCase()} words, ${b.name} on ${MORAL_LABELS[mb].toLowerCase()} words. People arguing from different foundations often talk past each other.` });
    }
    if (!out.length) out.push({ kind: 'caveat', text: 'No large differences between participants in this lens. That is a finding too.' });
    return out;
  }

  function topMoral(s) {
    let best = null, v = 0;
    for (const k in s.moral) if (s.moral[k] > v) { v = s.moral[k]; best = k; }
    return v >= 0.3 ? best : null;
  }

  function fmtMins(m) { if (m == null) return '—'; if (m < 1) return '<1 min'; if (m < 60) return Math.round(m) + ' min'; if (m < 1440) return (m / 60).toFixed(1) + ' h'; return (m / 1440).toFixed(1) + ' d'; }
  function fmtDate(d) { return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }); }
  function fmt(v, f) {
    if (v == null || Number.isNaN(v)) return '—';
    switch (f) {
      case 'pct': return Math.round(v * 100) + '%';
      case 'rate': return v.toFixed(2);
      case 'num1': return v.toFixed(1);
      case 'num2': return v.toFixed(2);
      case 'signed2': return (v >= 0 ? '+' : '') + v.toFixed(2);
      case 'int': return String(Math.round(v));
      case 'mins': return fmtMins(v);
      default: return String(v);
    }
  }

  /** Markdown report for export. */
  function toMarkdown(res, lens) {
    const L = LENSES[lens];
    const keys = Object.keys(METRICS).filter(k => METRICS[k].lenses.includes(lens));
    const names = res.stats.map(s => s.name);
    let md = `# Threadlens report: ${L.title} lens\n\n`;
    md += `${res.totals.messages} messages · ${res.people.length} people · ${fmtDate(res.range.from)} to ${fmtDate(res.range.to)}\n\n## Findings\n\n`;
    for (const f of findings(res, lens)) md += `- ${f.text}\n`;
    md += `\n## Measures\n\n| Measure | ${names.join(' | ')} |\n|---|${names.map(() => '---').join('|')}|\n`;
    for (const k of keys) md += `| ${METRICS[k].label}${METRICS[k].fmt === 'rate' ? ' (per 100 words)' : ''} | ${res.stats.map(s => fmt(s[k], METRICS[k].fmt)).join(' | ')} |\n`;
    if (lens === 'debate') {
      md += `\n## Moral vocabulary (per 100 words)\n\n| Foundation | ${names.join(' | ')} |\n|---|${names.map(() => '---').join('|')}|\n`;
      for (const k in MORAL_LABELS) md += `| ${MORAL_LABELS[k]} | ${res.stats.map(s => fmt(s.moral[k] || 0, 'rate')).join(' | ')} |\n`;
      md += `\n## Rhetorical cues (count)\n\n| Cue | ${names.join(' | ')} |\n|---|${names.map(() => '---').join('|')}|\n`;
      for (const k in RHET_LABELS) md += `| ${RHET_LABELS[k]} | ${res.stats.map(s => s.rhetoric[k] || 0).join(' | ')} |\n`;
    }
    md += `\n---\nGenerated locally by Threadlens. Word-list heuristics, not a diagnosis. Sarcasm, quotes and mixed languages confuse them. Read the messages, not just the numbers.\n`;
    return md;
  }

  return { parseChat, createAnalyzer, findings, toMarkdown, fmt, fmtMins, fmtDate, LENSES, METRICS, MORAL_LABELS, RHET_LABELS, MIN_WORDS_FOR_CLAIM };
});
