# The Threadlens scoring model

Everything Threadlens reports is counting, arithmetic and pattern matching. There is no machine-learning
model in the web app, nothing is trained on your data, and no number here is an opinion the program formed.
This document is the complete method: every list, every threshold, every formula, and every known way each
one is wrong.

If you only read one thing: **Threadlens measures how a conversation was conducted. It has no capacity to
judge whether anybody was correct, and it is deliberately built so that it cannot acquire one.**

- Implementation: [`web/src/core.js`](../web/src/core.js) (browser + Node) and
  [`python/threadlens/`](../python/threadlens/) (CLI, API). The two are held to identical output by
  [`test_rigor.py::test_matches_javascript`](../python/tests/test_rigor.py).
- Word lists: [`lexicons/lexicons.json`](../lexicons/lexicons.json) — one readable file, open to pull requests.

---

## 1. Parsing

WhatsApp exports are plain text with one message per line and continuation lines for multi-line messages.

| Step | Rule |
|---|---|
| Line shape | Android `DD/MM/YYYY, HH:MM - Name: text`, iOS `[DD/MM/YYYY, HH:MM:SS] Name: text`. Both 12- and 24-hour. |
| Date order | Auto-detected across the whole file: a day field above 12 proves DMY, a month field above 12 proves MDY, a four-digit first field proves YMD. Overridable in the UI. |
| Invisible marks | LTR/RTL marks, BOM and narrow no-break spaces are stripped; WhatsApp sprinkles them liberally. |
| System lines | Lines with no `Name: ` prefix (encryption notices, "X joined") are counted and discarded. |
| Media / deleted | `<Media omitted>`, `image omitted`, `This message was deleted` are recorded as message kinds with **no text**, so they count toward message totals but never toward word counts or any rate. |
| Edited | `<This message was edited>` is stripped and flagged. |

**Known failure:** a person whose display name contains `: ` can break the name/text split. Names longer than
60 characters are treated as system lines.

---

## 2. Per-message scoring

Each text message is tokenised (`\p{L}\p{N}'` runs, lowercased) and counted against every word list.

### Rates

Nearly every lexicon count is reported **per 100 words**, not as a raw total:

```
rate = 100 × matches / total_words_by_that_person
```

This is the single most important normalisation in the tool. Without it, whoever typed more would "win"
every category automatically.

### Heat

A transparent hostility heuristic in `0..1`. Not a sentiment model — a weighted count, damped by length:

```
raw  = profanity + insults + 0.6×group_labels + 0.4×status_put_downs
     + 1.2×personal_attack_phrases + 0.3×mocking
     + 0.5 if more than half the words are ALL-CAPS (and the message has >3 words)

heat = 1 − exp(−raw × 3 / √max(words, 6))
```

The square root means a single slur in a six-word message scores far hotter than the same slur buried in a
300-word essay, which matches how it reads. **Watch the trend across a conversation, not any single value.**

### Tone

The open [VADER](https://github.com/cjhutto/vaderSentiment) lexicon (MIT, Hutto & Gilbert 2014), with simple
negation: a negator within the preceding three tokens flips and dampens a word's valence by ×−0.74. The sum
is squashed to `−1..1` by `s / √(s² + 15)`. VADER is English-first and **materially undercounts romanised
Hindi and other code-mixed text.**

### Moral vocabulary

Five word lists after Moral Foundations Theory (Graham, Haidt & Nosek, 2009): care, fairness, loyalty,
authority, purity. Reported per 100 words. This is a *vocabulary* measure, not a measure of anyone's morals.
Its practical use is spotting that two people are arguing from different foundations, which is a common
reason an argument goes nowhere.

### Rhetorical cues

Regex phrase patterns for whataboutism, false choices, exit-then-return, unfalsifiable certainty, requests
for evidence, and personal attacks. Every match links to the message that produced it, because **a phrase
match is a prompt to re-read, not a finding.**

---

## 3. Rigor: scoring an argument's conduct

The Rigor lens produces one score in `0..100` per person from seven weighted components. Each component is
independently in `0..1`.

| Component | Weight | Definition |
|---|---|---|
| Sourcing | 25 | share of that person's factual claims that point at something checkable |
| Answering | 20 | share of the *other* person's direct questions they engaged with |
| Topic discipline | 15 | `1 − mean(drift)`, minus 0.1 per goalpost shift |
| Conduct | 15 | `1 − (hostile words per 100) / 4`, clamped to `0..1` |
| Specificity | 10 | mean concreteness of their claim sentences |
| Calibration | 10 | `0.5 + (hedging + 2×concessions − absolutist) / 6`, clamped |
| Self-correction | 5 | `min(1, explicit self-corrections / 2)` |

```
score = 100 × Σ(weightᵢ × componentᵢ) / Σ(weightᵢ)      over components that apply
```

**Components that do not apply are excluded from both sums rather than scored zero.** If nobody asked you a
question, Answering is `n/a` and the remaining 80 points are rescaled to 100. Scoring it zero would punish
you for someone else's silence.

### What counts as a claim

A sentence is a claim when **all** of these hold:

1. it contains no `?`;
2. it is at least 6 tokens long;
3. it contains a factual verb (`is, was, has, did, said, passed, ruled, caps, raised, …`, plus Hinglish
   `hai, tha, kiya, kaha, …`);
4. it does **not** open with an opinion marker (`I think`, `I feel`, `in my opinion`, `mujhe lagta`, …);
5. it does **not** open with an intent marker (`if `, `let's`, `I will`, `happy to`, `can you`, …).

Rules 4 and 5 exist because without them *"If you have a figure I will look at it"* was being filed as an
unsourced factual claim, which made careful speakers look vague.

### What counts as a source

| Signal | Example |
|---|---|
| URL | `https://…`, `www.…` |
| Named authority or document | court, tribunal, judgment, report, study, survey, census, chargesheet, FIR, gazette, section, article, act, page, "according to" |
| A date | `12 March 2026`, `4/2/2026`, a bare year `2026` |
| A statistic | `6%`, `1,240`, `12 crore`, `£40` |

A claim is **sourced** if it has a URL or a named document; **specific** if it has a date, statistic or proper
noun but no source; **vague** otherwise. The Sourcing component counts any of the four signals.

### Answering

For each question, the next 6 messages from anyone else are scanned. A reply counts as engaging with it when
it echoes at least 20% of the question's **IDF-weighted** distinctive vocabulary.

IDF weighting matters: a flat shared-word count returned zero for nearly every real chat reply, because short
replies repeat few words. Weighting by inverse document frequency means echoing *"shopkeepers"* counts and
echoing *"think"* does not.

### Topic drift

The opening topic is the top 12 terms by TF‑IDF across the first 10 text messages (documents = messages).
For each message:

```
similarity = min(1, Σ idf(shared topic terms) / (0.25 × Σ idf(all topic terms)))
drift      = 1 − similarity
```

Matching a quarter of the opening topic's weight counts as fully on-topic. A **goalpost shift** is recorded
when someone is challenged (a question or a request for evidence) and their next message has drift ≥ 0.8 that
is also ≥ 0.3 higher than their own previous message.

**Known failure:** a conversation that legitimately moves on will show high drift. Drift is a description,
not an accusation.

---

## 4. How neutrality is enforced

This is the part most likely to be wrong in a tool like this, so it is enforced by tests that fail the build
rather than by good intentions.

### No party, leader or policy names

No scoring list contains the name of a party, a politician, or a policy position. A test walks every list in
`lexicons.json` and fails if one appears. `khangressi` was removed from the v0.1 list for exactly this reason.

### Balanced group labels

`political_label` is tagged by **who typically uses a label**, not by who it targets. This is the direction
that matters: a list made mostly of labels used by one side would flag that side's speakers more often, which
is a thumb on the scale.

| Tag | Count |
|---|---|
| `right_coded` — used by the right | 37 |
| `left_coded` — used by the left | 33 |
| `neutral` — used by everyone | 11 |

Skew is 10.8%; a test fails above 20%. Every label is scored identically whoever uses it. **Listing a slur is
detection, not endorsement.**

### The mirror test

`samples/rigor_left_vs_right.txt` and `samples/rigor_right_vs_left.txt` are the same argument with the
speakers, the stances and the slurs swapped. Both test suites assert the two people's scores **swap** within
3 points. They currently swap exactly, to the decimal.

If a future change introduced any political lean, the mirror would stop swapping and the build would fail.

### Cross-implementation parity

`scripts/rigor-dump.mjs` emits the JavaScript result; `test_rigor.py::test_matches_javascript` compares it
field by field against the Python result on every sample. The web app and the CLI cannot silently diverge.

---

## 5. Optional local models (`pip install 'threadlens[deep]'`)

Off by default, never in the web app, and always run on your own machine:

- **Detoxify** (multilingual) — toxicity and insult probabilities per message.
- **A fallacy classifier** trained on the Logic dataset (Jin et al., 2022), per sentence.
- **NLI self-contradiction detection** (`cross-encoder/nli-deberta-v3-small`) — pairs of claims by the *same
  person* that a local model reads as contradictory, at probability > 0.8. Only claims sharing vocabulary are
  compared. Both quotes are always shown, because the model is often wrong.

None of these ever label a claim true or false.

---

## 6. Limits, stated plainly

| Limit | Why it matters |
|---|---|
| Sarcasm is invisible | `"Oh brilliant, another lecture"` scores as positive. |
| Quotation is not detected | Quoting someone else's insult counts against *you*. |
| Language coverage is uneven | Lists are English + romanised Hindi. Tone and heat undercount everything else. |
| Below 150 words per person | All comparisons switch off. Short chats support no conclusions. |
| Groups above 8 people | Everyone beyond the eighth is pooled as "Others". |
| A chat is not a relationship | It excludes every conversation you had in person, on a call, or in another app. |
| Emoji and voice notes | Voice notes carry no text at all, so a person who sends mostly voice notes will look silent. |

**Threadlens cannot detect personality, intelligence, mental health, honesty or love.** Any reading of these
numbers along those lines is yours, not the tool's, and it is not supported by anything in this document.

---

## 7. Changing the model

The word lists are the highest-value contribution, especially for Bengali, Tamil, Urdu and other languages.

1. Edit `lexicons/lexicons.json`.
2. Run `make sync` to copy them into the Python package (a test fails if the two drift apart).
3. Run `make test`. If you touched `political_label`, the balance test and the mirror test both have to pass.
4. Never attach a real chat to an issue or a pull request. Synthetic samples only.

If you change a threshold or a formula, change it in **both** `web/src/core.js` and `python/threadlens/`, or
the parity test will fail — which is the point of it.
