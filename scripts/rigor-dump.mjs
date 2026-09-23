// Dump the JS rigor result for one sample as JSON, so the Python test suite can
// assert byte-for-byte parity against its own implementation.
//   node scripts/rigor-dump.mjs samples/rigor_left_vs_right.txt
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const core = createRequire(import.meta.url)(join(root, 'web/src/core.js'));
const lex = JSON.parse(readFileSync(join(root, 'lexicons/lexicons.json'), 'utf8'));
const vader = JSON.parse(readFileSync(join(root, 'lexicons/vader.json'), 'utf8'));

const file = process.argv[2];
if (!file) { console.error('usage: node scripts/rigor-dump.mjs <sample.txt>'); process.exit(2); }

const res = core.createAnalyzer(lex, vader).analyse(core.parseChat(readFileSync(file, 'utf8')));
const G = res.rigor;
const out = {
  topicTerms: G.topicTerms,
  languages: G.languages,
  applies: G.applies,
  episodesScored: G.episodesScored,
  questionMix: G.questionMix,
  people: Object.fromEntries(Object.keys(G.people).map(n => {
    const p = G.people[n];
    return [n, {
      score: p.score, components: p.components, claims: p.claims,
      checkableClaims: p.checkableClaims, vagueClaims: p.vagueClaims,
      questionsAsked: p.questionsAsked, questionsPutToThem: p.questionsPutToThem,
      questionsAnswered: p.questionsAnswered, concessions: p.concessions,
      selfCorrections: p.selfCorrections, goalposts: p.goalposts.length,
    }];
  })),
  ledger: G.ledger.map(c => ({ who: c.who, text: c.text, status: c.status, checkable: c.checkable, challenged: c.challenged, answered: c.answered })),
  unanswered: G.unanswered.map(q => ({ who: q.who, text: q.text })),
};
process.stdout.write(JSON.stringify(out, null, 1));
