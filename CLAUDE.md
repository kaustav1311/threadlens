# Threadlens: notes for Claude Code

## What this is
Private WhatsApp-chat analysis. The web app runs 100% in the browser, and the built page blocks all network access via CSP.
The Python package mirrors the same scoring for the CLI, a self-hosted API, and optional local ML models.

## Architecture
```
            ┌──────────────── lexicons/*.json (single source of truth for word lists) ────────────────┐
            │                                                                                        │
 web/src/core.js  (parse → score → findings → rigor → markdown; UMD, browser + Node, no deps)        │
 web/src/app.js   (UI: file/zip/docx/paste → core → scorecards, panels, SVG charts, Web Worker)      │
 web/src/body.html + style.css                                                                       │
 web/vendor/jszip.min.js                                                                             │
        │                                                                                            │
 scripts/build.mjs ──► dist/index.html             full page, CSP: connect-src 'none', script hashes │
                  └──► dist/threadlens-artifact.html  body fragment for artifact hosts (no downloads) │
 scripts/rigor-dump.mjs  emits the JS rigor result so pytest can diff it against Python              │
 scripts/items.mjs   the units the eval gold set is labelled over — labeller and harness share it    │
 scripts/eval.mjs    `make eval`: P/R/F1 for the claim, question and is-it-an-argument gates         │
 dev/label.mjs       dev-only: pre-labels a local export with a local ollama model (never committed) │
                                                                                                     │
 python/threadlens/  parser.py · metrics.py · report.py (mirror core.js) ◄── data/*.json (make sync) ┘
                     rigor.py  (mirrors the rigor section of core.js, constant for constant)
                     deep.py   (Detoxify + fallacy classifier + local NLI self-contradiction, [deep])
                     cli.py    (`threadlens analyse|serve`, `--lens rigor`, `--ledger out.json`)
                     server.py (FastAPI, in-memory per-IP rate limits, 10 MB cap, no disk, no body logs)
```
Data flow: export text → `parseChat` (Android/iOS, 12/24h, date-order detection) → messages → `analyse` (per-person
counts, per-100-word rates, heat, sentiment, moral words, rhetoric regexes, reply times, day series) → `findings(lens)`
(symmetric comparisons, off below 150 words/person) → UI or Markdown/JSON.

`res.rigor` is a **lazy getter**: it is the most expensive pass and only one lens needs it, so four of the five
lenses never pay for it. Touching `res.rigor` computes it once and caches it.

Large exports (≥400k characters) are analysed in a **Web Worker** built from a Blob of `core.js`, which is why the
CSP allows `worker-src blob:`. The worker's copy of the source is read back off the page's own
`<script id="tl-core">` tag — it is *not* embedded a second time. If workers are blocked the page falls back to
the main thread and the result is identical.

## Commands
- `make test`: builds, then JS tests (`node --test "web/test/*.test.js"`) + Python tests (`cd python && pytest`)
- `make build`: dist files. Rebuild before committing UI changes; dist is committed so the page works offline.
  The build **fails** if `dist/index.html` exceeds 400 KB.
- `make sync`: copy lexicons into python/threadlens/data (a test fails if they drift)
- `make eval`: score the claim / question / is-it-an-argument gates against the hand-labelled
  `samples/labels_banglish_mixed.json`. **The primary gate for any scoring change** — `make test` proves the
  two implementations agree, `make eval` proves they are right. `--errors` prints what each gate got wrong.
  Baselines and the v0.2→v0.3 numbers are in docs/SCORING.md §6a.
- `node dev/label.mjs <chat.txt>`: dev-only. Pre-labels a local export with a local ollama model to build a
  gold set. Never run against anything that gets committed; `dev/out/` is gitignored.
- `threadlens serve`: API at http://127.0.0.1:8000/docs

## Invariants (do not break)
1. **No network from the web app.** Nothing in web/src may fetch, load fonts or use a CDN. The CSP in build.mjs must
   keep `connect-src 'none'`. `web/test/build.test.js` asserts this against the built page — including no `fetch`,
   no `sendBeacon`, no remote `<link>` or `<script>`, and hash-pinned inline scripts only.
2. **Symmetry.** Every metric is computed identically for every participant. Findings name both sides and the size of the gap.
3. **No diagnosis, no ideology.** Never output personality, IQ or mental-health labels. `political_label` is tagged by
   *who typically uses* a label (not who it targets, because that is what decides which side the metric leans against),
   and `left_coded` / `right_coded` must stay within 20% of each other in count. No party, leader or policy name may
   appear in any scoring list. Both suites enforce both rules, and the mirrored samples must swap their scores.
4. **JS ↔ Python parity.** Same thresholds and formulas in core.js, metrics.py and rigor.py. `test_rigor.py::
   test_matches_javascript` shells out to `scripts/rigor-dump.mjs` and compares the two field by field on every sample.
   (Loop-order optimisations that cannot change a count, like the inverted word index in `scoreMessage`, are fine.)
5. **No real chats** in the repo, issues or fixtures. Only synthetic samples in samples/.
6. `prefers-reduced-motion` must disable all animation — and every animated element must still land on its final
   state, not sit at zero. Asserted in `web/test/build.test.js`.

## Scoring decisions worth not re-litigating
- **Rigor scores the arguments in a chat, never the whole chat.** Applicability is decided *per episode*:
  an episode qualifies when people are both asserting (claims/message) and disagreeing (markers/message).
  Either alone is not an argument — a stream of links is not, nor is a round of swearing. `rigor.applies`
  is false when nothing qualifies, and then the ledger and the question list are **empty**: there is
  deliberately no fallback to "score everything anyway", so a caller that ignores `applies` still cannot
  print a confident analysis of an argument that never happened. This is what took a real chat's ledger
  from 112 entries of flat-hunting to 103 entries that are all the actual argument.
- **Three kinds of question, and only one is a debt.** `phatic` (asks for acknowledgement), `rhetorical`
  (asked to score a point), `substantive` (actually wants an answer). Only substantive questions enter
  Responsiveness or "questions nobody answered". Counting all three as one was most of what Responsiveness
  used to measure. `questionMix` reports all three over the whole chat.
- **A claim is an assertion about the world.** Obligation, plans, advice, requests, interior states
  ("I feel", "we love"), talk about the conversation itself, and unmarked questions are all rejected —
  see `rigor.modality`, `.meta_talk`, `.interior`, `.unmarked_question`. Meta-talk is only rejected when
  the sentence carries nothing checkable: "I said ninety minutes was the ward office figure" names a
  figure and stays a claim.
- **Stopwords and factual verbs are per language, and the set is chosen by detection.** An English-only
  chat is scored exactly as before; a Banglish one also gets `bn_latin`/`hi_latin`. Detection uses each
  language's *distinctive* words (the ones English does not already claim), because the English list is
  long and common enough to win on any text otherwise.
- **Per-100-words normalises a description, never a deduction.** Conduct and Calibration use *incidence* (the
  share of a person's messages carrying the thing). The old per-100-word rule made a terse speaker with one
  insult score worse than a verbose one with five. `test_conduct_counts_messages_not_words` pins it.
- **Drift is scoped to an episode**, split at the same 6-hour gap that defines "started a conversation". One
  global baseline turned a months-long chat's drift into a measure of elapsed time. Goalpost shifts only count
  inside one episode.
- **Rigor reports its own applicability** (`rigor.applicability`): claims per message against a 0.35 target. On
  a chat with no claims the UI says the lens is wrong rather than printing a confident zero.
- **The relationship input changes which lens opens and what is surfaced. It never changes a score.** Keep it
  that way: the moment it touches scoring, the tool takes a side.
- **Clipping happens in `parseChat`, not after.** `{from, to}` (JS) / `frm=, to=` (Python) so rates, episodes,
  drift and the ledger are all computed on the clip. A bare `to` date means the whole of that day.

## Gotchas already paid for
- **An opener list matched with `indexOf` matches inside words.** `intent_opener` held a bare `"id "` and
  `"ill "`, so `"sa|id i|t was ninety minutes"` and `"st|ill s|ays"` both matched and any sentence with
  *said*, *did* or *still* near its start was silently dropped as a statement of intent. Openers are
  word-boundary anchored (`openerRe` / `_opener_re`) — same class of bug as the month prefix below.
- **`"the"` was in `factual_verb`.** It is romanised Hindi for "they were", and it shares its spelling with
  the commonest word in English, so the verb gate passed everything on any English chat. Factual verbs are
  per-language now and the Hindi past copula is carried by `tha`/`thi`/`thay` instead. Watch for the same
  trap with any romanised homograph: `sob`, `mane`, `kar`, `par`, `hai`.
- **A URL's query string contains `?`.** A shared map pin was being counted as a question. Links are
  stripped before the question test.
- **The tokeniser splits `it's` into `it` + `s`**, so a copula contraction left the verb gate finding no
  verb at all. `RE_CONTRACTED_IS` expands them before the check.
- **Test fixtures built as "one message a day" are now N episodes of one**, and no episode of one is ever
  an argument, so they produce an empty ledger. Build a fixture as one sitting if it needs to be scored.
- A class with `display` beats the UA's `[hidden] { display: none }`. style.css carries a global `[hidden]` rule;
  without it `el.hidden = true` silently does nothing on `.progress` and friends.
- `%` is not a word character, so `\d+\s*%\b` never matches "6% a year". Percent gets its own regex branch.
- `/\b(jan|feb|mar|…)[a-z]*\b/` matches "market" and "maybe". Dates must look like dates.
- Answer matching by raw shared-word count returns 0 for almost every real chat reply; overlap is IDF-weighted.
- A leading space used to drop an exported line entirely (the `^` anchor). Pasted text nearly always has one,
  which was most of "paste doesn't work". Matching is done on a left-trimmed copy.
- The separator may be `-`, an en dash or an em dash, with or without a space after it.
- **The timestamp comes in four shapes, not two.** The clock may lead the date (`[10:07, 22/09/2026]`) and the
  year may be absent entirely (`[10:07, 22/09]`) — that is what selecting messages on a phone and copying them
  produces, and it is the most common paste. `headOf` / `_head` normalise all four to one canonical head
  `(d1, d2, d3, hh, mm, ss, am/pm)` so nothing downstream knows the difference. A year-less line inherits the
  last year seen and rolls forward by one if that would run the chat backwards (December → January).
- `core.js` is emitted **once**, as `<script id="tl-core">`; app.js reads its own source off that tag to build
  the Worker. Embedding it a second time as a string cost ~38 KB and kept breaking the page budget.

## Deployment
- **Web:** push to `main` → `.github/workflows/pages.yml` runs tests, builds, and deploys `dist/index.html` to GitHub Pages
  (one-time: repo Settings → Pages → Source = GitHub Actions). URL: https://kaustav1311.github.io/threadlens/
- **API (optional):** `docker build -t threadlens . && docker run -p 8000:8000 -e THREADLENS_RATE_PER_MIN=5 threadlens`,
  behind HTTPS (Caddy, Fly.io, Render or Cloud Run). Set `THREADLENS_TRUST_PROXY=1` only behind your own proxy.
- **Artifact copy:** dist/threadlens-artifact.html can be re-published to claude.ai from a Cowork session.

## Visitor counting (deliberately absent)
There is no analytics, and adding any beacon — including privacy-friendly ones like Cloudflare Web Analytics —
would break invariant 1 and make the page's own "no tracking, no cookies" claim false. If numbers are ever wanted:

- **Owner-side, zero client code:** GitHub → Insights → Traffic gives repo views and clones for free.
- **Server-side, zero client code:** serve the site through a CDN that reports from its own edge logs
  (Cloudflare zone analytics on a custom domain). The page stays sealed; the host does the counting.
- **Never:** a script in `dist/index.html`. If that is ever wanted anyway, the privacy copy in `body.html` and the
  CSP in `build.mjs` must change in the same commit, and `web/test/build.test.js` will fail until they do.

## Next work
See docs/HANDOFF.md.
