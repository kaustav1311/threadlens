/**
 * Label a chat export with a local ollama model, to build the eval gold set.
 *
 *   node dev/label.mjs <chat.txt> [--task all|claims|questions|episodes]
 *                                 [--model qwen2.5:3b] [--batch 8] [--out dev/out/labels.raw.json]
 *
 * This is a DEVELOPMENT tool, not part of the shipped product. It exists so that
 * "the keywording isn't good enough" becomes a precision/recall number instead of
 * an opinion. It talks to http://127.0.0.1:11434 — the web app never does, and
 * nothing here is inlined into dist/.
 *
 * The output is derived from a real conversation, so dev/out/ is gitignored. Only
 * the synthetic rewrite produced by dev/synthesise.mjs is ever committed.
 *
 * Three passes, not one. Each decision is labelled at the granularity it is
 * actually made at, which keeps every prompt to a single narrow judgement:
 *
 *   claims    — one binary call per non-question sentence of ≥4 tokens
 *   questions — one 3-way call per sentence containing '?'
 *   episodes  — one 4-way register call per conversation episode
 *
 * That matters more than model size here. Asked for four axes at once over every
 * sentence, a 3B model answers none of them: it labelled every sentence
 * claim:false and assigned question types to sentences that were not questions.
 * Asked one narrow question at a time, with contrasting examples, it is usable.
 * Language is deliberately NOT labelled by the model — it is decided by a
 * function-word heuristic, and having the model guess it would be circular.
 *
 * Runs are resumable: the output is rewritten after every batch and a second run
 * skips anything already labelled.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { core, buildItems, LABEL_VALUES } from '../scripts/items.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * OLLAMA_HOST is a *bind* address for the server and often reads `0.0.0.0` or a
 * bare `host:port`, neither of which is a URL a client can fetch. Normalise it:
 * add a scheme, add the default port, and rewrite the wildcard bind to loopback.
 */
function ollamaHost() {
  let h = (process.env.OLLAMA_HOST || '').trim();
  if (!h) return 'http://127.0.0.1:11434';
  if (!/^https?:\/\//i.test(h)) h = 'http://' + h;
  const u = new URL(h);
  if (u.hostname === '0.0.0.0' || u.hostname === '::') u.hostname = '127.0.0.1';
  if (!u.port) u.port = '11434';
  return u.origin;
}

const HOST = ollamaHost();

const PREAMBLE = `You label sentences from a private two-person chat for a linguistics dataset.
The chat mixes English with romanised Bengali/Hindi ("Kmn achis?", "Ei tatei to?", "eta behalar kache").
You label grammar and discourse function ONLY. Never judge the people, their politics, or whether anything is true.`;

/* One narrow judgement per task. The contrasting examples are the whole reason this
   works at 3B: "is this a claim?" in the abstract gets philosophical answers on
   casual chat, but "which of these two piles does it go in?" gets sorted. */
const TASKS = {
  claims: {
    values: LABEL_VALUES.claims,
    prompt: `${PREAMBLE}

For each numbered sentence answer ONE question: does it ASSERT A FACT ABOUT THE WORLD that a third party could in principle go and verify?

"yes" — a statement about the world, outside these two people's own arrangements:
  "The court struck it down in 2019"
  "Bengal has 294 assembly seats"
  "Dum dum metro station is closer to that side"
  "She works at that hospital"

"no" — everything else:
  plans and intentions: "I have to shift in a month", "I'll call you", "Jai dekhi"
  advice and instructions: "You have to contact them", "try 99acres", "should stay in south"
  opinions and feelings: "that's unfair", "I feel bad", "Place has to be clean bas"
  the speakers' own arrangements: "Room pachi na", "4th theke joining"
  greetings, jokes, reactions, one-word replies

Reply with JSON only: {"labels":[{"i":0,"v":"yes"},{"i":1,"v":"no"}]}
One object per input sentence, matching "i".`,
  },
  questions: {
    values: LABEL_VALUES.questions,
    prompt: `${PREAMBLE}

Each numbered line is a question. Classify what the asker WANTS.

"phatic" — greeting, check-in or back-channel. Expects acknowledgement, not information.
  "Kmn achis?"  "Wbu?"  "Really?"  "Mane?"  "Kothay achis?"  "Treat debe?"

"rhetorical" — asked to make a point. The asker is not waiting to be told anything.
  "And who exactly is going to pay for that?"  "Tab kaha the?"

"substantive" — genuinely requests information the asker does not have.
  "Didn't try 99acres?"  "What did the report actually say?"  "Green line metro ta ki suru hoi ni?"

Reply with JSON only: {"labels":[{"i":0,"v":"phatic"}]}
One object per input line, matching "i".`,
  },
  episodes: {
    values: LABEL_VALUES.episodes,
    prompt: `${PREAMBLE}

Each numbered block is one conversation, several messages long. Give it ONE register.

"casual"    — chit-chat, jokes, affection, catching up, emoji
"logistics" — arranging things: flats, addresses, money, travel, scheduling
"argument"  — disagreement or debate; the two sides are contesting something
"work"      — professional tasks, deadlines, deliverables

Pick what the conversation is MOSTLY doing. A single sharp line inside a friendly chat is still "casual".

Reply with JSON only: {"labels":[{"i":0,"v":"casual"}]}
One object per input block, matching "i".`,
  },
};

/** Stable map key for resume: id alone is not enough if the text changed under it. */
const keyOf = u => JSON.stringify([u.id, u.text]);

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function ask(model, task, batch) {
  const numbered = batch.map((u, i) => (task === 'episodes'
    ? `--- ${i} ---\n${u.text}`
    : `${i}. ${u.text.replace(/\s+/g, ' ').slice(0, 300)}`)).join('\n');
  const res = await fetch(HOST + '/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      format: 'json',
      // Temperature 0 so a re-run of the same batch gives the same labels: this is a
      // dataset, and a dataset that moves under you is not a baseline.
      options: { temperature: 0, num_ctx: 4096 },
      messages: [{ role: 'system', content: TASKS[task].prompt }, { role: 'user', content: numbered }],
    }),
  });
  if (!res.ok) throw new Error(`ollama ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  if (body.error) throw new Error('ollama: ' + body.error);
  const parsed = JSON.parse(body.message.content);
  const rows = Array.isArray(parsed) ? parsed : parsed.labels || [];
  const ok = new Set(TASKS[task].values);
  const out = new Map();
  for (const r of rows) {
    const i = Number(r.i);
    // A 3B model will occasionally invent an enum value or an index. Drop the row
    // rather than letting a bad label into the gold set; the review pass sees the hole.
    if (Number.isInteger(i) && i >= 0 && i < batch.length && ok.has(r.v)) out.set(i, r.v);
  }
  return out;
}

async function runTask(model, task, items, size, save) {
  const todo = items.filter(u => !u.label);
  if (!todo.length) { console.log(`${task}: already complete (${items.length})`); return; }
  console.log(`${task}: ${todo.length} to label of ${items.length}`);
  for (let at = 0; at < todo.length; at += size) {
    const batch = todo.slice(at, at + size);
    const t0 = Date.now();
    let got;
    try {
      got = await ask(model, task, batch);
    } catch (e) {
      console.error(`\n  ${task} batch at ${at} failed (${e.message}) — retrying once`);
      try { got = await ask(model, task, batch); } catch (e2) { console.error(`  skipped: ${e2.message}`); continue; }
    }
    batch.forEach((u, i) => { const v = got.get(i); if (v) u.label = v; });

    // A 3B model drops rows out of a batch unpredictably — roughly half of them on
    // this chat. Re-ask for the holes one at a time, where there is no index to lose
    // track of. Cheap at these volumes, and it turns a silently thin gold set into a
    // complete one.
    for (const u of batch) {
      if (u.label) continue;
      try { const one = await ask(model, task, [u]); const v = one.get(0); if (v) u.label = v; } catch { /* leave the hole for review */ }
    }
    save();
    const done = items.filter(u => u.label).length;
    process.stdout.write(`  ${task} ${done}/${items.length} (${((Date.now() - t0) / 1000).toFixed(1)}s/batch)   \r`);
  }
  process.stdout.write('\n');
}

async function main() {
  const file = process.argv[2];
  if (!file || file.startsWith('--')) {
    console.error('usage: node dev/label.mjs <chat.txt> [--task all|claims|questions|episodes] [--model qwen2.5:3b] [--batch 8]');
    process.exit(2);
  }
  const model = arg('model', 'qwen2.5:3b');
  const size = Math.max(1, Number(arg('batch', 8)));
  const want = arg('task', 'all');
  const out = join(root, arg('out', 'dev/out/labels.raw.json'));
  mkdirSync(dirname(out), { recursive: true });

  const parsed = core.parseChat(readFileSync(file, 'utf8'));
  const sets = buildItems(parsed.messages);
  console.log(`${parsed.messages.length} messages · ${sets.claims.length} claim candidates · `
    + `${sets.questions.length} questions · ${sets.episodes.length} episodes · model ${model}`);

  // Resume: carry over any label a previous run produced for the same text.
  if (existsSync(out)) {
    const prev = JSON.parse(readFileSync(out, 'utf8'));
    for (const task of Object.keys(TASKS)) {
      const by = new Map((prev[task] || []).filter(u => u.label).map(u => [keyOf(u), u.label]));
      let kept = 0;
      for (const u of sets[task]) { const l = by.get(keyOf(u)); if (l) { u.label = l; kept++; } }
      if (kept) console.log(`  resuming ${task}: ${kept} already labelled`);
    }
  }

  const save = () => writeFileSync(out, JSON.stringify({
    source: file, model, labelledAt: new Date().toISOString(),
    claims: sets.claims, questions: sets.questions,
    episodes: sets.episodes.map(({ msgs, ...e }) => e),
  }, null, 1));

  for (const task of Object.keys(TASKS)) {
    if (want !== 'all' && want !== task) continue;
    await runTask(model, task, sets[task], task === 'episodes' ? 4 : size, save);
  }
  save();

  console.log(`\nwrote ${out}`);
  for (const task of Object.keys(TASKS)) {
    const c = {};
    for (const u of sets[task]) c[u.label || '(none)'] = (c[u.label || '(none)'] || 0) + 1;
    console.log(`  ${task.padEnd(10)} ${Object.entries(c).sort((a, b) => b[1] - a[1]).map(x => x.join(':')).join('  ')}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
