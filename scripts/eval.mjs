/**
 * Score the current heuristics against a labelled gold set.
 *
 *   node scripts/eval.mjs [chat.txt] [labels.json]     # defaults to the committed sample
 *   node scripts/eval.mjs --dump <chat.txt>            # rigor summary only, no gold set needed
 *
 * This is the primary gate for every scoring change. "The keywording isn't good
 * enough" is only actionable once it is a number, and a number is only meaningful
 * against units someone actually looked at — so both sides build their units in
 * scripts/items.mjs and a mismatch is an error rather than a silent zero.
 *
 * Nothing here is inlined into dist/. It makes no network calls.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { core, buildItems, LABEL_VALUES } from './items.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const lex = JSON.parse(readFileSync(join(root, 'lexicons/lexicons.json'), 'utf8'));
const vader = JSON.parse(readFileSync(join(root, 'lexicons/vader.json'), 'utf8'));

const DEFAULT_CHAT = 'samples/sample_banglish_mixed.txt';
const DEFAULT_GOLD = 'samples/labels_banglish_mixed.json';

/* ------------------------------------------------------------------ metrics */

function prf(tp, fp, fn) {
  const p = tp + fp ? tp / (tp + fp) : 0;
  const r = tp + fn ? tp / (tp + fn) : 0;
  return { p, r, f1: p + r ? (2 * p * r) / (p + r) : 0, tp, fp, fn };
}

const pct = v => (v * 100).toFixed(1).padStart(5) + '%';

/** Per-class precision/recall plus macro-F1, for a multi-class decision. */
function report(title, pairs, values) {
  console.log(`\n${title}  (${pairs.length} labelled units)`);
  if (!pairs.length) { console.log('  nothing to score'); return null; }
  let correct = 0;
  const rows = [];
  for (const v of values) {
    let tp = 0, fp = 0, fn = 0;
    for (const [gold, got] of pairs) {
      if (gold === v && got === v) tp++;
      else if (got === v) fp++;
      else if (gold === v) fn++;
    }
    rows.push([v, prf(tp, fp, fn)]);
  }
  for (const [gold, got] of pairs) if (gold === got) correct++;
  console.log('  class          prec    recall      F1     n');
  for (const [v, m] of rows) {
    console.log(`  ${v.padEnd(12)} ${pct(m.p)} ${pct(m.r)} ${pct(m.f1)} ${String(m.tp + m.fn).padStart(5)}`);
  }
  const macro = rows.reduce((a, [, m]) => a + m.f1, 0) / rows.length;
  console.log(`  accuracy ${pct(correct / pairs.length)}   macro-F1 ${pct(macro)}`);
  return { accuracy: correct / pairs.length, macroF1: macro };
}

/* ------------------------------------------------- what the code does today */

/**
 * The current shipped decision for each unit, using the same exported gates the
 * scorer runs. `episodes` has no heuristic yet — workstream E adds one — so it is
 * reported as coverage rather than scored.
 */
function predict(messages) {
  const R = core.compileRigor(lex);
  // Score with the same stoplist the analyser would pick for this chat, not the
  // English default — otherwise the harness measures a gate the product never runs.
  const RS = core.scopeRigor(R, core.detectLanguages(messages, R.stopwordsBy));
  const items = buildItems(messages);
  const claims = new Map(), questions = new Map();
  for (const u of items.claims) {
    claims.set(u.id, core.classifySentence(u.text, RS, RS.stopwords).claim ? 'yes' : 'no');
  }
  for (const u of items.questions) {
    const kind = core.classifySentence(u.text, RS, RS.stopwords).question;
    // '' means the gate rejected it as a question entirely; anything it accepts is
    // currently treated as substantive, which is precisely what workstream D changes.
    questions.set(u.id, kind || 'phatic');
  }
  return { items, claims, questions };
}

/* --------------------------------------------------------------------- main */

function dump(file) {
  const parsed = core.parseChat(readFileSync(file, 'utf8'));
  const res = core.createAnalyzer(lex, vader).analyse(parsed);
  const G = res.rigor;
  console.log(`\n${file}`);
  console.log(`  ${parsed.messages.length} messages · ${G.episodes} episodes · people ${res.people.join(', ')}`);
  console.log(`  languages: ${(G.languages || ['en']).join(', ')}`);
  console.log(`  applicability: ${G.applicability.claims} claims / ${G.applicability.messages} messages `
    + `= ${G.applicability.claimsPerMessage.toFixed(3)}/msg · fit ${G.applicability.fit.toFixed(2)}`
    + `${G.applicability.weak ? ' · WEAK' : ''}`);
  console.log(`  opening topic: ${G.topicTerms.join(', ')}`);
  console.log(`  ledger ${G.ledgerTotal != null ? G.ledgerTotal : G.ledger.length} claims · unanswered ${G.unansweredTotal}`);
  for (const [n, p] of Object.entries(G.people)) {
    console.log(`  ${n}: score ${p.score.toFixed(1)} · claims ${p.claims} (vague ${p.vagueClaims}) · `
      + `asked ${p.questionsAsked} · answered ${p.questionsAnswered}/${p.questionsPutToThem} · `
      + `meanDrift ${p.meanDrift == null ? 'n/a' : p.meanDrift.toFixed(3)}`);
  }
}

function main() {
  const argv = process.argv.slice(2);
  const at = argv.indexOf('--dump');
  if (at >= 0) { dump(resolve(root, argv[at + 1] || DEFAULT_CHAT)); return; }

  const positional = argv.filter(a => !a.startsWith('--'));
  const chatPath = resolve(root, positional[0] || DEFAULT_CHAT);
  const goldPath = resolve(root, positional[1] || DEFAULT_GOLD);
  if (!existsSync(chatPath) || !existsSync(goldPath)) {
    console.error(`missing eval data:\n  chat  ${chatPath}\n  gold  ${goldPath}\n`
      + 'Build it with dev/label.mjs then dev/synthesise.mjs — see docs/SCORING.md.');
    process.exit(2);
  }

  const parsed = core.parseChat(readFileSync(chatPath, 'utf8'));
  const gold = JSON.parse(readFileSync(goldPath, 'utf8'));
  const { items, claims, questions } = predict(parsed.messages);

  // Align on id. A gold label with no matching unit means the two sides disagree
  // about the sentence split, which would quietly invalidate every number below.
  const align = (task, predictions) => {
    const byId = new Map(items[task].map(u => [u.id, u]));
    const pairs = [];
    let orphaned = 0;
    for (const g of gold[task] || []) {
      if (!g.label) continue;
      if (!byId.has(g.id)) { orphaned++; continue; }
      pairs.push([g.label, predictions.get(g.id)]);
    }
    if (orphaned) {
      console.error(`\n${task}: ${orphaned} gold labels have no matching unit — the gold set and `
        + 'scripts/items.mjs disagree about this chat. Regenerate the gold set.');
      process.exitCode = 1;
    }
    return pairs;
  };

  console.log(`chat  ${chatPath}\ngold  ${goldPath}`);
  console.log(`${parsed.messages.length} messages · ${items.claims.length} claim candidates · `
    + `${items.questions.length} questions · ${items.episodes.length} episodes`);

  report('CLAIM DETECTION   is this sentence an assertion about the world?',
    align('claims', claims), LABEL_VALUES.claims);
  report('QUESTION TYPE     what does the asker want?',
    align('questions', questions), LABEL_VALUES.questions);

  // --errors prints what the gate got wrong, which is the only view that tells you
  // what to fix next. A score alone says a gate is bad, not why.
  if (argv.includes('--errors')) {
    for (const [task, predictions] of [['claims', claims], ['questions', questions]]) {
      const wrong = (gold[task] || []).filter(g => g.label && predictions.has(g.id) && predictions.get(g.id) !== g.label);
      if (!wrong.length) continue;
      console.log(`\n${task.toUpperCase()} — ${wrong.length} wrong`);
      for (const g of wrong) {
        console.log(`  gold ${String(g.label).padEnd(12)} got ${String(predictions.get(g.id)).padEnd(12)} ${g.text.slice(0, 84)}`);
      }
    }
  }

  // Episode register is labelled four ways, but the code makes one binary call:
  // is this conversation an argument? That is what Rigor scopes itself to.
  const eps = (gold.episodes || []).filter(e => e.label);
  if (eps.length) {
    const argues = core.createAnalyzer(lex, vader).analyse(parsed).rigor.episodeArgues || [];
    const pairs = eps.map((e, i) => [e.label === 'argument' ? 'argument' : 'not', argues[i] ? 'argument' : 'not']);
    report('IS IT AN ARGUMENT?  which conversations Rigor should score', pairs, ['argument', 'not']);
    if (argv.includes('--errors')) {
      eps.forEach((e, i) => {
        const got = argues[i] ? 'argument' : 'not';
        const want = e.label === 'argument' ? 'argument' : 'not';
        if (got !== want) console.log(`  episode ${e.id}: gold ${e.label} (${want}) got ${got} — ${e.to - e.from + 1} messages`);
      });
    }
  }
  console.log('');
}

main();
