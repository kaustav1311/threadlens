# Handoff: v0.2 scope

Three workstreams. Do them in order and keep `make test` green after each. Read CLAUDE.md first. The invariants there are
hard requirements.

---

## 1. Rigor mode: a "political rigor test" lens

**Goal:** score *how well each person argued*, not *what they believe*. It should be usable on any heated political chat
(left, right, any country) without favouring a side.

### UI
- Add a fifth lens, **Rigor**, shown as a distinct mode: its own accent colour and a "Rigor test" badge.
- Headline: one **Rigor score per person (0–100)** with a breakdown bar of its components, not a single mystery number.
- A **Claim ledger** table: each extracted claim → who → date → status (Sourced / Specific but unsourced / Vague) → a
  "challenged?" flag → "answered?" flag.
- An **Unanswered questions** list: direct questions from A that B never addressed, and the reverse.
- A **Drift timeline**: how far each message strays from the opening topic (0–1), with the moments someone changed subject after being challenged.

### Components (all symmetric, all explainable)

| Component | Heuristic (web, no network) | Weight |
|---|---|---|
| Sourcing | claims with a URL, a named document/court/report, a date or a statistic ÷ all claims | 25 |
| Specificity | numbers, dates, proper nouns per claim sentence | 10 |
| Responsiveness | share of the other person's questions answered: the next reply within N messages shares ≥2 content keywords with the question, or quotes it | 20 |
| Topic discipline | 1 − mean drift from opening-topic keywords (TF-IDF of the first 10 text messages); penalise a drift jump right after a challenge (goalpost shift) | 15 |
| Conduct | 1 − normalised rate of personal attacks, group labels, status put-downs and profanity (existing lexicons) | 15 |
| Calibration | hedges and concessions ("fair point", "I was wrong", "you're right about") on contested claims; absolutist words reduce it | 10 |
| Self-correction | explicit corrections of one's own earlier claim | 5 |

- **Claim extraction (web):** sentence split; a claim is a declarative sentence with ≥6 words containing a factual verb
  pattern (is/was/were/has/have/did/killed/said/passed…, plus Hinglish "hai/tha/the/kiya"). No question marks, no
  pure-opinion openers ("I think", "I feel" → marked opinion, not claim).
- **Source detection:** URLs; patterns like `(court|high court|supreme court|report|study|survey|chargesheet|FIR|act|section \d+)`;
  a date or year; a percent or number with a unit.
- **Deep mode (Python only, `[deep]`):**
  - Local NLI (`cross-encoder/nli-deberta-v3-small`) to flag *self-contradictions*: a pair of claims by the same person with contradiction probability > 0.8. Show both quotes side by side.
  - The existing fallacy classifiers, per claim.
  - Optional **source-verification hook:** the CLI can emit the claim ledger as JSON for a human or an LLM to verify.
    Never auto-label a claim true or false in the web app.

### Neutrality guardrails (required)
- Extend `political_label` with equivalent slurs from all sides and several countries (e.g. bhakt/sickular/libtard/
  urban naxal/sanghi/commie/fascist/woke/MAGA-tard/…). Add a test that asserts the list stays balanced by tag
  (tag each entry `left-coded`, `right-coded` or `neutral`, and require the left/right counts to be within ±20%).
- No topic, party or leader name may appear in any scoring list.
- Add two synthetic samples with **mirrored roles** (the same argument structure, with positions swapped). A test must show the Rigor scores swap within ±3 points.

### Acceptance
- `samples/rigor_left_vs_right.txt` and `samples/rigor_right_vs_left.txt` (mirrored) pass the swap test.
- Every Rigor number has a "how was this computed" popover.
- Python `threadlens analyse --lens rigor [--deep]` produces the same component scores as the web app, within rounding.

---

## 2. Less text, more signal: UI refresh

The current page is text-heavy. Target: someone understands the result in five seconds, and the detail is one click deeper.

- **Hero:** cut to a headline plus one line. Move the three promises into three compact icon chips under the drop zone.
- **Results first view:** a "scorecard" row per person (avatar initial, colour, 3–4 big numbers with sparkline or micro-bar),
  then the findings as short cards (max 12 words each, "why?" expands the full sentence).
- **Measures table:** collapse into a "Details" drawer. Show the top 5 differences by default.
- **How it works / What it measures / Privacy:** turn into a 3-icon strip plus accordions. Target at least 50% less visible text.
- **Animations** (CSS only, no libraries; all off under `prefers-reduced-motion`):
  - drop zone: a border "breathing" pulse on drag-over, and a file-card fly-in on drop;
  - a parsing progress bar driven by real progress (chunked parse with `requestIdleCallback`/`setTimeout` yields);
  - numbers count up once on first render (≤600 ms);
  - chart lines draw in with `stroke-dashoffset`, and bars grow from the baseline;
  - lens switch: a 150 ms cross-fade, and the segmented control slides its active pill.
- Keep: both themes, 400 px layout, keyboard focus states, the table view for every chart.
- Performance budget: dist/index.html < 400 KB, first render < 100 ms on the sample, a 50k-message chat analysed in < 2 s
  (move analysis to a Web Worker built from a Blob URL; allow `worker-src blob:` in the CSP).

---

## 3. Deployment and release

1. Create the GitHub repo `kaustav1311/threadlens` (public), push `main`, and enable Pages → Source = GitHub Actions.
2. Confirm CI is green and the Pages URL works; test offline by saving the page.
3. Tag `v0.2.0`, write release notes, and attach `dist/index.html` as a downloadable offline build.
4. Optional API: deploy the Docker image to Fly.io, Render or Cloud Run with HTTPS, and keep the default rate limits.
5. Update README screenshots (`docs/screenshot.png`), mobile + desktop, light + dark.
