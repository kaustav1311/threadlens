/*! Threadlens core — parsing + scoring. MIT License. Runs in the browser and in Node; makes no network calls. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ThreadlensCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------------------------------------------------------------- parsing */

  const INVISIBLE = /[\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;
  // The year is optional: selecting messages on a phone and copying them yields
  // a bare 22/09 with no year at all.
  const D = String.raw`(\d{1,4})[./-](\d{1,2})(?:[./-](\d{1,4}))?`;
  const T = String.raw`(\d{1,2})[:.](\d{2})(?:[:.](\d{2}))?\s*([AaPp]\.?\s?[Mm]\.?)?`;
  // The separator may be a hyphen, en dash or em dash, and the space after it is
  // optional: some exports and re-exports write 01:02 -Ravi: or 01:02-Ravi:.
  const SEP = String.raw`\s*[-–—]\s*`;
  const ANDROID = new RegExp(`^${D},?\\s+${T}${SEP}(.*)$`);
  const IOS = new RegExp(`^\\[${D},?\\s+${T}\\]\\s?(.*)$`);
  // Clock first: [10:07, 22/09/2026] Ravi: hello. WhatsApp writes the timestamp
  // this way round on a number of locales, and it is the shape people paste most
  // often. The capture groups come out clock-first, so headOf reorders them and
  // everything downstream still sees one canonical head.
  const IOS_TF = new RegExp(`^\\[${T},?\\s+${D}\\]\\s?(.*)$`);
  const ANDROID_TF = new RegExp(`^${T},?\\s+${D}${SEP}(.*)$`);

  /** Canonical head: [line, d1, d2, d3, hh, mm, ss, am/pm, rest]. */
  function headOf(probe) {
    const dateFirst = probe.match(IOS) || probe.match(ANDROID);
    if (dateFirst) return dateFirst;
    const m = probe.match(IOS_TF) || probe.match(ANDROID_TF);
    return m ? [m[0], m[5], m[6], m[7], m[1], m[2], m[3], m[4], m[8]] : null;
  }

  const MEDIA = /^(<media omitted>|<attached:.*>|(image|video|audio|sticker|gif|document|contact card) omitted|null)$/i;
  const DELETED = /^(this message was deleted|you deleted this message|message deleted)$/i;
  const EDITED = /\s*<this message was edited>\s*$/i;

  function cleanLine(l) {
    return l.replace(INVISIBLE, '').replace(/[\u202f\u00a0]/g, ' ').replace(/\r$/, '');
  }

  /** Split raw export text into header matches + continuation lines. */
  function tokenizeLines(text, onProgress) {
    const lines = text.split(/\n/).map(cleanLine);
    const out = [];
    let seen = 0, first = '';
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Match on a left-trimmed copy: pasted text almost always picks up an
      // indent somewhere, and a single leading space used to drop the line.
      const probe = line.replace(/^\s+/, '');
      if (probe) { seen++; if (!first) first = probe.slice(0, 120); }
      const m = headOf(probe);
      if (m) out.push({ head: m, rest: m[8] });
      else if (out.length) out[out.length - 1].rest += '\n' + line;
      if (onProgress && (i & 4095) === 4095) onProgress(i / lines.length);
    }
    out.lineCount = seen;
    out.firstLine = first;
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

  /**
   * @param {object} ctx carries the last year seen and the previous timestamp,
   *   so a year-less line copied off a phone can be placed. Mutated as we go.
   */
  function toDate(h, order, ctx) {
    let d, mo, y = null;
    const bare = h[3] === undefined || h[3] === '';
    if (bare) {
      // No year in the line at all. YMD cannot apply to two components.
      if (order === 'MDY') { mo = +h[1]; d = +h[2]; } else { d = +h[1]; mo = +h[2]; }
    } else if (order === 'YMD') { y = +h[1]; mo = +h[2]; d = +h[3]; }
    else if (order === 'MDY') { mo = +h[1]; d = +h[2]; y = +h[3]; }
    else { d = +h[1]; mo = +h[2]; y = +h[3]; }
    if (y !== null && y < 100) y += 2000;
    let hr = +h[4];
    const mi = +h[5], se = h[6] ? +h[6] : 0;
    const ap = h[7] ? h[7].replace(/[.\s]/g, '').toLowerCase() : '';
    if (ap === 'pm' && hr < 12) hr += 12;
    if (ap === 'am' && hr === 12) hr = 0;
    if (y === null) {
      // Inherit the last year we saw, or assume this year. An export runs
      // forwards, so if that lands before the previous message the chat has
      // crossed a new year and the year goes up by one.
      y = ctx.year || new Date().getFullYear();
      let dt = new Date(y, mo - 1, d, hr, mi, se);
      if (isNaN(dt.getTime())) return null;
      if (ctx.prev && dt < ctx.prev) dt = new Date(y + 1, mo - 1, d, hr, mi, se);
      ctx.prev = dt;
      return dt;
    }
    const dt = new Date(y, mo - 1, d, hr, mi, se);
    if (isNaN(dt.getTime())) return null;
    ctx.year = y;
    ctx.prev = dt;
    return dt;
  }

  /**
   * Parse a WhatsApp export (Android or iOS, 12h or 24h, any locale separator).
   * @param {string} text
   * @param {{dateOrder?: 'auto'|'DMY'|'MDY'|'YMD', onProgress?: (fraction:number)=>void,
   *           from?: Date|string, to?: Date|string}} [opts]
   *   from/to clip the conversation to a window. Clipping happens here, before
   *   any scoring, so rates, episodes, drift and the ledger are all computed on
   *   the clip rather than filtered afterwards.
   */
  function parseChat(text, opts) {
    opts = opts || {};
    const from = opts.from ? new Date(opts.from) : null;
    // `to` is inclusive of the whole day when a bare date is given.
    let to = opts.to ? new Date(opts.to) : null;
    if (to && /^\d{4}-\d{2}-\d{2}$/.test(String(opts.to))) to = new Date(to.getTime() + 864e5 - 1);
    const rows = tokenizeLines(String(text || ''), opts.onProgress);
    const order = !opts.dateOrder || opts.dateOrder === 'auto' ? detectDateOrder(rows.map(r => r.head)) : opts.dateOrder;
    const messages = [];
    let system = 0;
    let clipped = 0;
    const ctx = { year: null, prev: null };
    for (const r of rows) {
      const date = toDate(r.head, order, ctx);
      if (!date) continue;
      if ((from && date < from) || (to && date > to)) { clipped++; continue; }
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
    return {
      messages, dateOrder: order, systemLines: system,
      lineCount: rows.lineCount || 0, firstLine: rows.firstLine || '',
      clipped, clip: from || to ? { from: from || null, to: to || null } : null,
    };
  }

  /* -------------------------------------------------------------- lexicons */

  function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  const IS_WORDCHAR = /[\p{L}\p{N}']/u;

  /** A lexicon entry is either a flat array or an object of tagged arrays (e.g. political_label). */
  function listOf(v) { return Array.isArray(v) ? v : Object.keys(v).reduce((a, k) => a.concat(v[k]), []); }

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
    return n + countPhrases(c, lower);
  }

  /** The phrase/emoji half of countList, split out so the word half can be indexed. */
  function countPhrases(c, lower) {
    let n = 0;
    for (const re of c.phrases) { re.lastIndex = 0; const m = lower.match(re); if (m) n += m.length; }
    for (const e of c.emoji) n += lower.split(e).length - 1;
    return n;
  }

  function tokenize(lower) { return lower.match(/[\p{L}\p{N}']+/gu) || []; }

  /* -------------------------------------------------------------- sentiment */

  const NEGATORS = new Set(['not', 'no', 'never', 'nahi', 'nahin', 'na', "don't", 'dont', "isn't", 'isnt', "wasn't", "can't", 'cant', "won't", 'without']);
  /** @param {Map<string, number>} vader */
  function sentiment(tokens, vader) {
    let s = 0;
    for (let i = 0; i < tokens.length; i++) {
      let v = vader.get(tokens[i]);
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
      if (k.startsWith('_') || k === 'moral' || k === 'rhetoric' || k === 'rigor') continue;
      L[k] = compileList(listOf(lex[k]));
    }
    const MORAL = {}; for (const k of Object.keys(lex.moral)) MORAL[k] = compileList(lex.moral[k]);
    const RHET = {}; for (const k of Object.keys(lex.rhetoric)) RHET[k] = compileList(lex.rhetoric[k], true);
    const rg = lex.rigor || { stopwords: [], factual_verb: [], opinion_opener: [], intent_opener: [], source_term: [], concession: [], self_correction: [] };
    const R = {
      stopwords: new Set(rg.stopwords),
      factualVerb: new Set(rg.factual_verb),
      opinionOpener: rg.opinion_opener.map(s => s.toLowerCase()),
      intentOpener: (rg.intent_opener || []).map(s => s.toLowerCase()),
      sourceTerm: compileList(rg.source_term),
      concession: compileList(rg.concession),
      selfCorrection: compileList(rg.self_correction, true),
    };

    // One pass over a message's tokens instead of one pass per word list.
    // A token that appears in several lists still increments each of them, so
    // every count is unchanged -- this is purely a loop order change.
    const index = (lists) => {
      const words = new Map(), withPhrases = [];
      for (const k of Object.keys(lists)) {
        for (const w of lists[k].words) {
          let a = words.get(w);
          if (!a) words.set(w, a = []);
          a.push(k);
        }
        if (lists[k].phrases.length || lists[k].emoji.length) withPhrases.push(k);
      }
      return { words, withPhrases, keys: Object.keys(lists) };
    };
    const LX = index(L), MX = index(MORAL);
    const VADER = new Map(Object.keys(vader).map(k => [k, vader[k]]));

    const tally = (X, lists, tokens, lower) => {
      const out = {};
      for (const k of X.keys) out[k] = 0;
      for (const t of tokens) { const a = X.words.get(t); if (a) for (const k of a) out[k]++; }
      for (const k of X.withPhrases) out[k] += countPhrases(lists[k], lower);
      return out;
    };

    function scoreMessage(m) {
      const lower = m.text.toLowerCase();
      const tokens = tokenize(lower);
      const c = tally(LX, L, tokens, lower);
      const moral = tally(MX, MORAL, tokens, lower);
      const rhet = {}; for (const k of Object.keys(RHET)) rhet[k] = countList(RHET[k], tokens, lower);
      const capsWords = (m.text.match(/\b[A-Z]{3,}\b/g) || []).length;
      const questions = (m.text.match(/\?/g) || []).length > 0 ? 1 : 0;
      // Heat: a transparent hostility heuristic (0..1). Weighted hits, damped by message length.
      const raw = c.profanity * 1 + c.insult * 1 + c.political_label * 0.6 + c.status_hierarchy * 0.4 +
        rhet.personal_attack * 1.2 + c.mock * 0.3 + (tokens.length > 3 && capsWords / tokens.length > 0.5 ? 0.5 : 0);
      const heat = raw ? 1 - Math.exp(-raw * 3 / Math.sqrt(Math.max(tokens.length, 6))) : 0;
      return { words: tokens.length, c, moral, rhet, capsWords, questions, heat, sent: sentiment(tokens, VADER) };
    }

    /**
     * Analyse parsed messages.
     * @param {{messages: Array}} parsed
     * @param {{anonymise?: boolean, maxPeople?: number, onProgress?: (fraction:number)=>void}} [opts]
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
      let done = 0;
      for (const m of msgs) {
        if (opts.onProgress && (++done & 2047) === 2047) opts.onProgress(done / msgs.length);
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

      const result = {
        people, stats, series, hottest, others,
        range: { from: msgs[0].date, to: msgs[msgs.length - 1].date, days: days.length },
        totals: { messages: msgs.length, words: stats.reduce((a, s) => a + s.words, 0) },
        dateOrder: parsed.dateOrder,
      };
      // Rigor is the most expensive pass and only one lens needs it, so it is
      // computed on first access and cached. Four of the five lenses never pay for it.
      let rigorCache = null;
      Object.defineProperty(result, 'rigor', {
        enumerable: true,
        get() { return rigorCache || (rigorCache = rigorAnalysis(scored, people, R)); },
      });
      return result;
    }

    return { analyse, scoreMessage, rigor: (scored, people) => rigorAnalysis(scored, people, R) };
  }

  /* ------------------------------------------------------------------ rigor
   * "How well did each person argue?" — never "who was right?".
   * Every component is a conduct measure: sourcing, answering, staying on topic,
   * civility, hedging, self-correction. Nothing here can read a political position:
   * the political_label list is scored identically whoever uses it, and the mirrored
   * sample pair in samples/ is a regression test that swapping sides swaps the scores.
   */

  const RIGOR_WEIGHTS = { sourcing: 25, specificity: 10, responsiveness: 20, topic: 15, conduct: 15, calibration: 10, selfCorrection: 5 };
  const RIGOR_LABELS = {
    sourcing: 'Sourcing', specificity: 'Specificity', responsiveness: 'Answering',
    topic: 'Topic discipline', conduct: 'Conduct', calibration: 'Calibration', selfCorrection: 'Self-correction',
  };
  const RIGOR_HOW = {
    sourcing: 'Share of this person’s factual claims that point at something checkable: a link, a named report/court/section, a date, or a statistic.',
    specificity: 'How concrete the claims are — numbers, dates and proper nouns per claim sentence, capped so one very detailed line cannot carry the score.',
    responsiveness: 'Of the direct questions the other person asked, the share this person engaged with in the next 6 messages (sharing at least two content words with the question).',
    topic: 'How close their messages stay to the opening topic (TF–IDF of the first 10 messages), minus a penalty each time they swerve off-topic right after being challenged.',
    conduct: 'Starts at 1 and falls with personal attacks, group labels, status put-downs and profanity per 100 words \u2014 four per 100 words takes it to zero. Identical list for everyone.',
    calibration: 'Hedging and granting the other side a point raise it; absolutist words (always, never, everyone) lower it. A neutral speaker sits at 0.50.',
    selfCorrection: 'Explicitly correcting one’s own earlier claim (“I was wrong about…”, “scratch that”). Two corrections is full marks.',
  };

  const EPISODE_GAP_HOURS = 6;     // the same gap that defines "started a conversation"
  const EPISODE_OPENING = 6;       // messages of an episode that define its topic
  const CONDUCT_ZERO = 0.3;        // share of messages carrying hostility at which Conduct hits 0
  const RIGOR_FIT_FULL = 0.35;     // claims per message at which Rigor is fully applicable
  const RIGOR_FIT_WEAK = 0.4;      // below this fit, the UI warns rather than asserting
  const CALIBRATION_SPAN = 1.5;    // how far incidence must move to swing Calibration end to end
  const RIGOR_ANSWER_WINDOW = 6;   // messages after a question in which a reply still counts as answering it
  const RIGOR_MIN_CLAIM_WORDS = 6; // shorter sentences are too thin to call a claim
  const RIGOR_KEYWORD_MIN = 3;     // content words must be this long to count for overlap
  const RIGOR_ANSWER_SIM = 0.2;    // share of a question's distinctive weight a reply must echo to count as engaging with it
  const RIGOR_OVERLAP = 2;         // shared content words needed to link a reply to a claim
  const TOPIC_OPENING_MSGS = 10;
  const TOPIC_TERMS = 12;
  const LEDGER_MAX = 500;         // rendered claims; scoring still uses every claim
  const UNANSWERED_MAX = 200;
  const DRIFT_POINTS = 400;       // the timeline is downsampled to this many points
  const TOPIC_FULL_MATCH = 0.25;   // matching 25% of the opening topic's weight counts as fully on-topic
  const DRIFT_HIGH = 0.8;
  const DRIFT_JUMP = 0.3;
  const GOALPOST_PENALTY = 0.1;

  const RE_URL = /(?:https?:\/\/|www\.)\S+/i;
  const RE_YEAR = /\b(?:19|20)\d{2}\b/;
  // A bare month prefix is not a date: /\bmar[a-z]*/ also matches "market", and /\bmay[a-z]*/
  // matches "maybe". Require a day or a numeric date next to it.
  const MONTH = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*';
  const RE_DATE = new RegExp(
    '\\b\\d{1,2}(?:st|nd|rd|th)?\\s+' + MONTH + '\\b' +
    '|\\b' + MONTH + '\\.?\\s+\\d{1,2}\\b' +
    '|\\b\\d{1,2}[\\/.-]\\d{1,2}[\\/.-]\\d{2,4}\\b', 'i');
  // `%` is not a word character, so a trailing \b after it never matches:
  //  \d+\s*%\b fails on 6% a year. Keep  for the spelled-out units only.
  const RE_STAT = /\b\d+(?:[.,]\d+)?\s*%|\b\d+(?:[.,]\d+)?\s*(?:percent|per cent|crore|lakh|lakhs|million|billion|km|kg|tonnes?|rs\.?|inr|usd)\b|[₹$£€]\s?\d|\b\d{2,}\b/i;
  const RE_PROPER = /^[A-Z][a-z]{2,}/;

  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

  /** Split a message into sentences. A newline ends one too: chat writers rarely punctuate. */
  function splitSentences(text) {
    return String(text).split(/(?<=[.!?…])\s+|\n+/).map(s => s.trim()).filter(Boolean);
  }

  /** Content words used for question/answer overlap and topic matching. */
  function contentWords(tokens, stop) {
    const out = [];
    for (const t of tokens) if (t.length >= RIGOR_KEYWORD_MIN && !stop.has(t)) out.push(t);
    return out;
  }

  /** Does this sentence point at anything a reader could go and check? */
  function claimEvidence(sentence, lower, tokens, R) {
    const url = RE_URL.test(sentence);
    const named = countList(R.sourceTerm, tokens, lower) > 0;
    const dated = RE_YEAR.test(sentence) || RE_DATE.test(sentence);
    const stat = RE_STAT.test(sentence);
    let proper = 0;
    const words = sentence.split(/\s+/);
    for (let i = 1; i < words.length; i++) if (RE_PROPER.test(words[i])) proper++;
    const sourced = url || named;
    const specific = dated || stat || proper > 0;
    return {
      url, named, dated, stat, proper, sourced, specific,
      checkable: url || named || dated || stat,
      status: sourced ? 'sourced' : specific ? 'specific' : 'vague',
      specificity: Math.min(1, ((dated ? 1 : 0) + (stat ? 1 : 0) + Math.min(proper, 2) * 0.5) / 2),
    };
  }

  function overlapCount(a, b) { let n = 0; for (const t of a) if (b.has(t)) n++; return n; }

  /**
   * Split a chat into episodes at the same six-hour gap that defines "started a
   * conversation". Measuring drift against one global opening is meaningless once
   * a chat spans weeks -- it just measures elapsed time.
   * @returns {number[]} episode index per message
   */
  function episodeOf(msgs) {
    const out = new Array(msgs.length);
    let ep = 0;
    for (let i = 0; i < msgs.length; i++) {
      if (i && (msgs[i].date - msgs[i - 1].date) / 36e5 >= EPISODE_GAP_HOURS) ep++;
      out[i] = ep;
    }
    return out;
  }

  /** Keep at most `max` evenly spaced points: a 50k-point timeline renders no better than 400. */
  function downsample(arr, max) {
    if (arr.length <= max) return arr;
    const step = arr.length / max, out = [];
    for (let i = 0; i < max; i++) out.push(arr[Math.floor(i * step)]);
    return out;
  }

  /**
   * How much of a question's distinctive vocabulary a reply echoes, 0..1.
   * Weighted by IDF so echoing "shopkeepers" counts far more than echoing "think":
   * a flat word count made every short reply look like a non-answer.
   */
  function echoScore(qkw, have, idf) {
    let total = 0, hit = 0;
    for (const t of qkw) { const w = idf(t); total += w; if (have.has(t)) hit += w; }
    return total ? hit / total : 0;
  }

  /**
   * Score argument quality per person. `scored` is the per-message output of analyse().
   * Components that do not apply (nobody asked them anything, they made no claims) are
   * null and drop out of the weighted average rather than scoring zero.
   */
  function rigorAnalysis(scored, people, R) {
    const msgs = scored;
    const stop = R.stopwords;
    // Re-tokenise here rather than keeping tokens on every scored message: on a 50k-message
    // chat that array would dominate memory, and this pass is cheap.
    const toks = msgs.map(m => tokenize(m.text.toLowerCase()));

    /* --- topic and drift, scoped to a conversation episode --- */
    const episode = episodeOf(msgs);
    const episodeCount = msgs.length ? episode[msgs.length - 1] + 1 : 0;
    const df = Object.create(null);
    const perMsgWords = msgs.map((m, i) => {
      const w = contentWords(toks[i], stop);
      for (const t of new Set(w)) df[t] = (df[t] || 0) + 1;
      return w;
    });
    // One Set per message, built once. The responsiveness and challenge scans below
    // both look up the same messages repeatedly; rebuilding these was the hot path.
    const contentSets = perMsgWords.map(w => new Set(w));
    const N = Math.max(msgs.length, 1);
    const idf = t => Math.log(1 + N / (1 + (df[t] || 0)));
    /** Top terms of a slice of messages, by TF-IDF against the whole chat. */
    const topicOf = (from, to, k) => {
      const tf = Object.create(null);
      for (let i = from; i < to; i++) for (const t of perMsgWords[i]) tf[t] = (tf[t] || 0) + 1;
      return Object.keys(tf)
        .map(t => ({ t, w: tf[t] * idf(t) }))
        .sort((a, b) => b.w - a.w || (a.t < b.t ? -1 : 1))
        .slice(0, k);
    };

    const bounds = [];
    for (let i = 0; i < msgs.length; i++) {
      const e = episode[i];
      if (!bounds[e]) bounds[e] = { from: i, to: i + 1 };
      else bounds[e].to = i + 1;
    }
    const epTopic = bounds.map(b => {
      const terms = topicOf(b.from, Math.min(b.to, b.from + EPISODE_OPENING), TOPIC_TERMS);
      const total = terms.reduce((a, x) => a + x.w, 0);
      const index = Object.create(null);
      for (const x of terms) index[x.t] = x.w;
      return { terms, total, index };
    });

    // Each message is measured against the opening of ITS OWN episode.
    const drift = perMsgWords.map((w, i) => {
      const T = epTopic[episode[i]];
      if (!T || !T.total) return 0;
      let hit = 0;
      for (const t of new Set(w)) if (T.index[t]) hit += T.index[t];
      return 1 - clamp01(hit / (TOPIC_FULL_MATCH * T.total));
    });

    // "The opening topic" in the UI means what the chat started as: episode one.
    const topic = epTopic.length ? epTopic[0].terms : [];

    /* --- per person accumulators --- */
    const P = {};
    for (const p of people) P[p] = {
      claims: [], questionsAsked: 0, answered: 0, putToThem: 0,
      drifts: [], goalposts: [], concession: 0, selfCorrection: 0,
      hostile: 0, words: 0, hedge: 0, absolutist: 0,
      // incidence: how many of their MESSAGES carried the thing, not how many words
      msgs: 0, hostileMsgs: 0, hedgeMsgs: 0, concessionMsgs: 0, absolutistMsgs: 0,
    };

    /* --- sentences: claims and questions --- */
    const ledger = [];
    const questions = [];
    msgs.forEach((m, i) => {
      const p = P[m.who];
      if (!p) return;
      p.drifts.push(drift[i]);
      p.words += m.words;
      p.msgs++;
      const hostile = (m.c.profanity || 0) + (m.c.insult || 0) + (m.c.political_label || 0) + (m.c.status_hierarchy || 0) + (m.rhet.personal_attack || 0);
      p.hostile += hostile;
      if (hostile) p.hostileMsgs++;
      p.hedge += m.c.hedge || 0;
      if (m.c.hedge) p.hedgeMsgs++;
      p.absolutist += m.c.absolutist || 0;
      if (m.c.absolutist) p.absolutistMsgs++;
      const lowerMsg = m.text.toLowerCase();
      const conc = countList(R.concession, toks[i], lowerMsg);
      p.concession += conc;
      if (conc) p.concessionMsgs++;
      p.selfCorrection += countList(R.selfCorrection, toks[i], lowerMsg);

      for (const sent of splitSentences(m.text)) {
        const lower = sent.toLowerCase();
        const sTok = tokenize(lower);
        if (!sTok.length) continue;
        if (sent.indexOf('?') >= 0) {
          const kw = contentWords(sTok, stop);
          if (kw.length) { questions.push({ who: m.who, i, date: m.date, text: sent, kw: new Set(kw), answered: false }); p.questionsAsked++; }
          continue;
        }
        if (sTok.length < RIGOR_MIN_CLAIM_WORDS) continue;
        if (!sTok.some(t => R.factualVerb.has(t))) continue;
        // An opinion, an offer, a plan or a request is not a checkable claim.
        // Counting them inflates the Sourcing denominator and makes a careful
        // speaker look vague, so they are skipped rather than scored.
        let skip = false;
        for (const o of R.opinionOpener) { const at = lower.indexOf(o); if (at >= 0 && at < 30) { skip = true; break; } }
        if (!skip) for (const o of R.intentOpener) { const at = lower.indexOf(o); if (at >= 0 && at < 30) { skip = true; break; } }
        if (skip) continue;
        const claim = { who: m.who, i, date: m.date, text: sent, kw: new Set(contentWords(sTok, stop)), challenged: false, challengedAt: -1, answered: false, ...claimEvidence(sent, lower, sTok, R) };
        p.claims.push(claim);
        ledger.push(claim);
      }
    });

    /* --- responsiveness: did the other person engage with the question? --- */
    for (const q of questions) {
      for (const name of people) if (name !== q.who) P[name].putToThem++;
      for (let j = q.i + 1; j <= Math.min(msgs.length - 1, q.i + RIGOR_ANSWER_WINDOW); j++) {
        const m = msgs[j];
        if (m.who === q.who || !P[m.who]) continue;
        if (echoScore(q.kw, contentSets[j], idf) >= RIGOR_ANSWER_SIM) {
          P[m.who].answered++;
          q.answered = true;
          break;
        }
      }
    }

    /* --- was a claim challenged, and did its author then back it up? --- */
    for (const c of ledger) {
      for (let j = c.i + 1; j <= Math.min(msgs.length - 1, c.i + RIGOR_ANSWER_WINDOW); j++) {
        const m = msgs[j];
        if (m.who === c.who) continue;
        const isChallenge = (m.rhet.evidence_request || 0) > 0 || m.text.indexOf('?') >= 0;
        if (isChallenge && overlapCount(c.kw, contentSets[j]) >= RIGOR_OVERLAP) { c.challenged = true; c.challengedAt = j; break; }
      }
      if (!c.challenged) continue;
      for (let j = c.challengedAt + 1; j <= Math.min(msgs.length - 1, c.challengedAt + RIGOR_ANSWER_WINDOW) && !c.answered; j++) {
        const m = msgs[j];
        if (m.who !== c.who) continue;
        for (const sent of splitSentences(m.text)) {
          const lower = sent.toLowerCase();
          const sTok = tokenize(lower);
          if (overlapCount(c.kw, new Set(contentWords(sTok, stop))) >= RIGOR_OVERLAP && claimEvidence(sent, lower, sTok, R).checkable) { c.answered = true; break; }
        }
      }
    }

    /* --- goalpost shifts: challenged, then an off-topic swerve --- */
    msgs.forEach((m, i) => {
      const p = P[m.who];
      if (!p || i === 0) return;
      const prev = msgs[i - 1];
      if (prev.who === m.who) return;
      // A six-hour gap starts a new conversation, so a challenge cannot be
      // "dodged" by a message three days later.
      if (episode[i] !== episode[i - 1]) return;
      if (!((prev.rhet.evidence_request || 0) > 0 || prev.text.indexOf('?') >= 0)) return;
      let lastOwn = -1;
      for (let j = i - 1; j >= 0; j--) if (msgs[j].who === m.who && episode[j] === episode[i]) { lastOwn = j; break; }
      if (lastOwn < 0) return;
      if (drift[i] >= DRIFT_HIGH && drift[i] - drift[lastOwn] >= DRIFT_JUMP)
        p.goalposts.push({ date: m.date, from: drift[lastOwn], to: drift[i], text: m.text.slice(0, 160) });
    });

    /* --- components --- */
    const out = {};
    for (const name of people) {
      const p = P[name];
      const n = p.claims.length;
      const per100 = k => (p.words ? (100 * k) / p.words : 0);
      // Conduct and Calibration use INCIDENCE -- the share of this person's
      // messages that carried the thing -- not a per-100-word rate. Per 100 words
      // is the right normaliser for a descriptive rate, but the wrong basis for a
      // deduction: 20 words with one insult scored 5.0/100w and floored at zero,
      // while 500 words with five insults scored 1.0/100w and kept most of the
      // marks. That punished brevity and rewarded padding.
      const share = k => (p.msgs ? k / p.msgs : 0);
      const components = {
        sourcing: n ? p.claims.filter(c => c.checkable).length / n : null,
        specificity: n ? mean(p.claims.map(c => c.specificity)) : null,
        responsiveness: p.putToThem ? Math.min(1, p.answered / p.putToThem) : null,
        topic: p.drifts.length ? clamp01(1 - mean(p.drifts) - GOALPOST_PENALTY * p.goalposts.length) : null,
        conduct: p.msgs ? clamp01(1 - share(p.hostileMsgs) / CONDUCT_ZERO) : null,
        calibration: p.msgs
          ? clamp01(0.5 + (share(p.hedgeMsgs) + 2 * share(p.concessionMsgs) - share(p.absolutistMsgs)) / CALIBRATION_SPAN)
          : null,
        selfCorrection: Math.min(1, p.selfCorrection / 2),
      };
      let num = 0, den = 0;
      for (const k in RIGOR_WEIGHTS) if (components[k] != null) { num += RIGOR_WEIGHTS[k] * components[k]; den += RIGOR_WEIGHTS[k]; }
      out[name] = {
        name, score: den ? (100 * num) / den : null, components,
        claims: n,
        sourcedClaims: p.claims.filter(c => c.sourced).length,
        checkableClaims: p.claims.filter(c => c.checkable).length,
        vagueClaims: p.claims.filter(c => c.status === 'vague').length,
        questionsAsked: p.questionsAsked, questionsPutToThem: p.putToThem, questionsAnswered: p.answered,
        concessions: p.concession, selfCorrections: p.selfCorrection,
        goalposts: p.goalposts, meanDrift: p.drifts.length ? mean(p.drifts) : null,
        hostileMessages: p.hostileMsgs, scoredMessages: p.msgs,
        hostileShare: p.msgs ? p.hostileMsgs / p.msgs : null,
      };
    }

    // How much of an argument is this, really? Sourcing and Answering are only
    // meaningful where there are claims and questions to score. Measured, not guessed.
    const totalClaims = ledger.length;
    const claimsPerMessage = msgs.length ? totalClaims / msgs.length : 0;
    const fit = clamp01(claimsPerMessage / RIGOR_FIT_FULL);

    return {
      people: out,
      weights: RIGOR_WEIGHTS,
      applicability: {
        claims: totalClaims,
        messages: msgs.length,
        claimsPerMessage,
        fit,
        weak: fit < RIGOR_FIT_WEAK,
      },
      episodes: episodeCount,
      episodeTopics: epTopic.slice(0, 12).map(t => t.terms.slice(0, 6).map(x => x.t)),
      topicTerms: topic.map(x => x.t),
      ledgerTotal: ledger.length,
      ledger: ledger.slice(0, LEDGER_MAX).map(c => ({ who: c.who, date: c.date, text: c.text.slice(0, 240), status: c.status, checkable: c.checkable, challenged: c.challenged, answered: c.answered })),
      unansweredTotal: questions.reduce((n, q) => n + (q.answered ? 0 : 1), 0),
      unanswered: questions.filter(q => !q.answered).slice(0, UNANSWERED_MAX).map(q => ({ who: q.who, date: q.date, text: q.text.slice(0, 240) })),
      drift: downsample(msgs.map((m, i) => ({ who: m.who, date: m.date, drift: drift[i] })), DRIFT_POINTS),
    };
  }

  /* --------------------------------------------------------------- findings */

  const LENSES = {
    overview: { title: 'Overview', blurb: 'Who talks, when, how much, and in what tone.' },
    debate: { title: 'Debate', blurb: 'How an argument was conducted: questions vs. assertions, evidence, labels, escalation.' },
    personal: { title: 'Personal', blurb: 'Balance and warmth: who reaches out, who replies, affection and apology.' },
    work: { title: 'Work', blurb: 'Responsiveness and clarity: reply times, action words, politeness, after-hours load.' },
    rigor: { title: 'Rigor', blurb: 'How well each side argued \u2014 sourcing, answering, staying on topic, conduct. Not who was right.', badge: 'Rigor test' },
  };

  const METRICS = {
    share: { label: 'Share of messages', fmt: 'pct', lenses: ['overview', 'personal', 'work'] },
    wordsPerMsg: { label: 'Words per message', fmt: 'num1', lenses: ['overview', 'debate', 'rigor'] },
    questionRate: { label: 'Messages that ask a question', fmt: 'pct', lenses: ['overview', 'debate', 'personal', 'work', 'rigor'] },
    absolutist: { label: 'Absolutist words', fmt: 'rate', lenses: ['debate', 'rigor'], note: 'always, never, every, nothing, simple…' },
    hedge: { label: 'Hedging words', fmt: 'rate', lenses: ['debate', 'rigor'], note: 'maybe, I think, probably…' },
    evidence: { label: 'Evidence words', fmt: 'rate', lenses: ['debate', 'work', 'rigor'], note: 'source, proof, court, data…' },
    self: { label: '“I / me / my”', fmt: 'rate', lenses: ['debate', 'personal'] },
    other: { label: '“You / your”', fmt: 'rate', lenses: ['debate', 'personal'] },
    we: { label: '“We / us”', fmt: 'rate', lenses: ['personal', 'work'] },
    politicalLabel: { label: 'Group labels', fmt: 'rate', lenses: ['debate', 'rigor'], note: 'bhakt, libtard, anti-national…' },
    status: { label: 'Status / age put-downs', fmt: 'rate', lenses: ['debate', 'rigor'], note: 'kid, chote, grow up…' },
    profanity: { label: 'Profanity', fmt: 'rate', lenses: ['overview', 'debate'] },
    insult: { label: 'Insults', fmt: 'rate', lenses: ['debate', 'personal', 'rigor'] },
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

  /** Findings for the Rigor lens. Conduct only: never a verdict on the position argued. */
  function rigorFindings(res) {
    const out = [];
    const G = res.rigor;
    if (!G) return out;
    const ranked = Object.keys(G.people).map(n => G.people[n])
      .filter(p => p.score != null && p.name !== 'Others')
      .sort((a, b) => b.score - a.score);
    if (ranked.length < 2) {
      out.push({ kind: 'caveat', text: 'Rigor needs at least two people with enough text to compare.' });
      return out;
    }
    const [hi, lo] = ranked;
    out.push({
      kind: 'compare',
      short: hi.name + ' argued more rigorously: ' + Math.round(hi.score) + ' vs ' + Math.round(lo.score),
      text: hi.name + ' scores ' + Math.round(hi.score) + '/100 against ' + lo.name + "'s " + Math.round(lo.score) +
        '. This measures how the case was made \u2014 sourcing, answering, staying on topic, conduct \u2014 not whether either position is correct.',
    });

    let worst = null, gap = 0;
    for (const k in RIGOR_WEIGHTS) {
      const a = hi.components[k], b = lo.components[k];
      if (a == null || b == null) continue;
      if (Math.abs(a - b) > gap) { gap = Math.abs(a - b); worst = k; }
    }
    if (worst && gap >= 0.15) {
      const a = hi.components[worst], b = lo.components[worst];
      const lead = a > b ? hi : lo, trail = a > b ? lo : hi;
      out.push({
        kind: 'compare',
        short: 'Biggest gap: ' + RIGOR_LABELS[worst].toLowerCase(),
        text: 'The widest gap is ' + RIGOR_LABELS[worst].toLowerCase() + ': ' + lead.name + ' ' + Math.max(a, b).toFixed(2) +
          ' against ' + trail.name + "'s " + Math.min(a, b).toFixed(2) + '. ' + RIGOR_HOW[worst],
      });
    }
    for (const p of ranked.slice(0, 2)) {
      const missed = p.questionsPutToThem - p.questionsAnswered;
      if (p.questionsPutToThem >= 3 && missed >= 2)
        out.push({
          kind: 'pattern',
          short: p.name + ' left ' + missed + ' question' + (missed === 1 ? '' : 's') + ' unanswered',
          text: missed + ' of the ' + p.questionsPutToThem + ' direct questions put to ' + p.name +
            ' were never engaged with in the following ' + RIGOR_ANSWER_WINDOW + ' messages.',
        });
      if (p.claims >= 5 && p.vagueClaims / p.claims >= 0.7)
        out.push({
          kind: 'pattern',
          short: p.name + "'s claims are mostly unsourced",
          text: p.vagueClaims + ' of ' + p.name + "'s " + p.claims + ' factual claims carry no link, date, number or named source.',
        });
      if (p.goalposts.length)
        out.push({
          kind: 'trend',
          short: p.name + ' changed the subject under challenge',
          text: p.name + ' swerved off the opening topic right after being challenged ' + p.goalposts.length +
            ' time' + (p.goalposts.length === 1 ? '' : 's') + '.',
        });
      if (p.selfCorrections)
        out.push({
          kind: 'pattern',
          short: p.name + ' corrected themselves',
          text: p.name + ' explicitly corrected an earlier claim ' + p.selfCorrections + ' time' +
            (p.selfCorrections === 1 ? '' : 's') + '. That is rare, and it counts for something.',
        });
    }
    out.push({
      kind: 'caveat',
      short: 'This scores conduct, not correctness',
      text: 'Rigor scores how an argument was made, never which side is right. The same word lists and thresholds run against everyone.',
    });
    return out;
  }

  /** Plain-language findings. Symmetric: every comparison names both sides and the size of the gap. */
  function findings(res, lens) {
    const out = [];
    if (lens === 'rigor') return rigorFindings(res);
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
    if (lens === 'rigor' && res.rigor) {
      const G = res.rigor;
      const ns = Object.keys(G.people).filter(n => G.people[n].score != null);
      md += `\n## Rigor scores\n\n| Component | Weight | ${ns.join(' | ')} |\n|---|---|${ns.map(() => '---').join('|')}|\n`;
      md += `| **Score /100** | 100 | ${ns.map(n => Math.round(G.people[n].score)).join(' | ')} |\n`;
      for (const k in RIGOR_WEIGHTS)
        md += `| ${RIGOR_LABELS[k]} | ${RIGOR_WEIGHTS[k]} | ${ns.map(n => (G.people[n].components[k] == null ? 'n/a' : G.people[n].components[k].toFixed(2))).join(' | ')} |\n`;
      md += `\nComponents that do not apply are marked n/a and drop out of the weighted average.\n`;
      md += `\nOpening topic: ${G.topicTerms.join(', ')}\n`;
      if (G.ledger.length) {
        md += `\n## Claim ledger\n\n| Who | When | Claim | Status | Challenged | Answered |\n|---|---|---|---|---|---|\n`;
        for (const cl of G.ledger.slice(0, 40))
          md += `| ${cl.who} | ${fmtDate(cl.date)} | ${cl.text.replace(/\|/g, '\\|').slice(0, 120)} | ${cl.status} | ${cl.challenged ? 'yes' : '\u2014'} | ${cl.answered ? 'yes' : '\u2014'} |\n`;
      }
      if (G.unanswered.length) {
        md += `\n## Questions that never got an answer\n\n`;
        for (const q of G.unanswered.slice(0, 20)) md += `- **${q.who}**, ${fmtDate(q.date)}: ${q.text}\n`;
      }
    }
    md += `\n---\nGenerated locally by Threadlens. Word-list heuristics, not a diagnosis. Sarcasm, quotes and mixed languages confuse them. Read the messages, not just the numbers.\n`;
    return md;
  }

  return {
    parseChat, createAnalyzer, findings, toMarkdown, fmt, fmtMins, fmtDate,
    LENSES, METRICS, MORAL_LABELS, RHET_LABELS, MIN_WORDS_FOR_CLAIM,
    RIGOR_WEIGHTS, RIGOR_LABELS, RIGOR_HOW, RIGOR_ANSWER_WINDOW, splitSentences,
  };
});
