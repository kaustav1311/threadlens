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
for evidence, personal attacks, and **caveats** — the one cue family that marks a good move, qualifying a claim
rather than asserting it flat. Every match links to the message that produced it, because **a phrase match is
a prompt to re-read, not a finding.**

Each family carries its own positive and negative examples in `lexicons/lexicons.json` under
`_rhetoric_examples`, and both suites assert that every family still matches its examples and still rejects
its counter-examples. A cue that quietly stops matching otherwise shows up as a column of zeroes, which reads
exactly like "nobody did this". That test is what caught `what about` firing on *"What about Tuesday, are you
free?"* — scheduling, not whataboutism, and now excluded explicitly.

---

## 3. Rigor: scoring an argument's conduct

The Rigor lens produces one score in `0..100` per person from seven weighted components. Each component is
independently in `0..1`.

| Component | Weight | Definition |
|---|---|---|
| Sourcing | 25 | share of that person's factual claims that point at something checkable |
| Answering | 20 | share of the *other* person's direct questions they engaged with |
| Topic discipline | 15 | `1 − mean(drift)`, minus 0.1 per goalpost shift |
| Conduct | 15 | `1 − (share of their messages carrying hostility) / 0.30`, clamped |
| Specificity | 10 | mean concreteness of their claim sentences |
| Calibration | 10 | `0.5 + (hedge share + 2×concession share − absolutist share) / 1.5`, clamped |
| Self-correction | 5 | `min(1, explicit self-corrections / 2)` |

```
score = 100 × Σ(weightᵢ × componentᵢ) / Σ(weightᵢ)      over components that apply
```

### Why Conduct and Calibration count messages, not words

Per 100 words is the right normaliser for a *descriptive* rate: it stops whoever typed more from winning every
category automatically. It is the wrong basis for a *deduction*.

Take two people, each hostile in exactly one message out of ten. One writes 20-word messages, the other writes
200-word essays. Under a per-100-words rule the terse speaker scores about 5.0 and is floored at zero, while the
verbose speaker scores about 0.5 and keeps most of the marks. **Brevity was punished and padding rewarded** —
the opposite of what a conduct measure should do.

Conduct and Calibration therefore use **incidence**: the share of that person's messages that carried the thing
at all. "A quarter of your messages contained an insult, a slur or a put-down" does not move with how much
anyone types, and you can check it by hand. `test_conduct_counts_messages_not_words` pins it: the terse and
verbose speakers above must receive identical Conduct.

Per-100-word rates are unchanged everywhere else, because everywhere else they describe rather than deduct.

**Components that do not apply are excluded from both sums rather than scored zero.** If nobody asked you a
question, Answering is `n/a` and the remaining 80 points are rescaled to 100. Scoring it zero would punish
you for someone else's silence.

### What counts as a claim

A claim is an **assertion about the world**. Not a plan, not advice, not an opinion, and not a remark about
the conversation itself. A sentence qualifies when it is at least 5 tokens, carries a verb, and survives every
rejection below:

| Rejected | Because | Example |
|---|---|---|
| Question | it asks rather than asserts | *Where did you see four hours?* |
| Unmarked question | chat writers drop the `?` constantly | *How's the new place been* |
| Opinion opener | flagged as a view, not a fact | *I think the report is wrong* |
| Intent opener | a statement of what someone will do | *If you have a figure I will look at it* |
| Modality | obligation, plan, advice, request | *The place has to be clean* · *try the bigger complexes* |
| Interior state | nobody can check how you feel | *we love the little ones* · *I don't care* |
| Meta-talk | about the conversation, not the world | *you asked for a number and that's the number* |

Meta-talk is only rejected when the sentence carries **nothing checkable**. *"I said ninety minutes was the
ward office figure"* reports what was said and also names a figure, so it stays a claim.

Two things the verb test had to learn. The tokeniser splits `it's` into `it` + `s`, so a copula contraction
left the gate finding no verb at all; contractions are expanded before the check. And a bare citation —
*"Section 3 of the same report, page 12"* — has no verb and is still a claim about where something can be
checked, so a named source plus a number or date is accepted on its own.

**Measured accuracy: 91.1% macro-F1** on the labelled set (§6a). The errors that remain are evaluative
sentences: *"It was violence for a political cause"* is a claim, *"It is political in every way possible"* is
not, and no word list sees the difference.

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

### Topic drift, scoped to an episode

Measuring every message against the first ten messages of the *entire export* is only meaningful when the whole
export is one argument. Across months it is nonsense: a chat legitimately moves on, and "drift" degenerates
into a measure of elapsed time.

The chat is therefore split into **episodes** at the same six-hour gap that defines "started a conversation",
and each message is measured against the opening (up to 6 messages) of **its own episode**. A goalpost shift is
only recorded within one episode, so a challenge on Tuesday cannot be "dodged" by a message on Friday. The
topic the UI calls "the opening topic" is episode one's, because that is what a reader means by what the chat
started as.

Within an episode, its topic is the top 12 terms by TF‑IDF across the first 10 text messages (documents = messages).
For each message:

```
similarity = min(1, Σ idf(shared topic terms) / (0.25 × Σ idf(all topic terms)))
drift      = 1 − similarity
```

Matching a quarter of the opening topic's weight counts as fully on-topic. A **goalpost shift** is recorded
when someone is challenged (a question or a request for evidence) and their next message has drift ≥ 0.8 that
is also ≥ 0.3 higher than their own previous message.

**Known failure:** a conversation that legitimately changes subject *within one episode* will still show
drift. Drift is a description, not an accusation.

### Is Rigor even the right lens?

Rigor asks "did you source that?". That is a fair question of a political argument and a meaningless one of a
chat about dinner. Rather than guess a conversation's genre from invented weights, Threadlens measures the
thing that actually decides it:

```
claims per message = extracted claims / text messages
fit                = min(1, claims per message / 0.35)
```

Below a fit of 0.4 the lens stops asserting and says so: *"Only 3 factual claims in 120 messages. Rigor is
built for an argument where people assert things and are asked to back them up. This reads more like
conversation."* A tool that knows when it is the wrong instrument is worth more than one that always produces
a number.

This is also why the app asks, optionally, what kind of chat it is looking at — a partner, family, a
colleague, someone you argue with online. That answer chooses which lens opens first and which findings are
worth surfacing. **It never changes how anything is scored.**

### Clipping a conversation

A long export usually holds many conversations, only one of which you care about. `parseChat(text, {from, to})`
in JavaScript, `parse_chat(text, frm=, to=)` in Python, narrows the chat **before anything is scored**, so
rates, episodes, drift, the ledger and every finding are computed on the clip rather than filtered afterwards.
A bare `to` date includes the whole of that day.

The web app offers windows computed from the chat itself rather than from the calendar: the last 30 and 90
days *of this chat*, its busiest month, and the week its heat peaked. "Last 30 days" relative to today is
useless for an argument that finished in March.

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

## 6a. Measured accuracy, and the baseline to beat

Section 6 lists the limits in words. This section lists them as numbers, because "the keyword matching
isn't good enough" is only actionable once it is measured.

`make eval` scores the two sentence-level gates against a hand-labelled set,
[`samples/labels_banglish_mixed.json`](../samples/labels_banglish_mixed.json), over
[`samples/sample_banglish_mixed.txt`](../samples/sample_banglish_mixed.txt). That fixture is synthetic but
not arbitrary: it reproduces the measured structure of a real Bengali-English chat — median 3 words per
message, 11% of messages carrying a question, nine episodes at the six-hour split, and two genuine
arguments buried inside small talk — with invented people, places and specifics. No real conversation is
stored in this repository.

Both sides build their units in [`scripts/items.mjs`](../scripts/items.mjs), so a gold label and a
prediction can never be compared across two different sentence splits. `node scripts/eval.mjs --errors`
prints what each gate got wrong, which is the only view that says what to fix next.

| Decision | v0.2 accuracy | v0.2 macro-F1 | v0.3 accuracy | v0.3 macro-F1 |
|---|---|---|---|---|
| Claim detection | 57.1% | 55.2% | **92.2%** | **91.1%** |
| Question type | 65.0% | 26.3% | **95.0%** | **94.0%** |
| Is it an argument? | — | — | **100%** | **100%** |

### What v0.2 was actually doing

- **Claim detection precision was 36.8%.** Nearly two thirds of what the claim ledger printed was not a
  claim — it was a plan, a piece of advice, an opinion, or a remark about the speakers' own arrangements.
- **Phatic and rhetorical questions scored 0.0%.** The code had no concept of either, so every `Wbu?` and
  every whataboutism was booked as a substantive question somebody had failed to answer.

Three causes, two of them outright bugs:

1. **The stoplist was English-only.** The romanised Bengali function words that make up much of a chat like
   this (`na`, `ami`, `ta`, `kore`, `theke`, `tui`, `eta`) were treated as rare, distinctive content words.
   Topic vectors, drift and question/answer overlap were all computed on that mistake.
2. **Openers matched inside words.** `intent_opener` contained a bare `"id "` and `"ill "`, matched with
   `indexOf`. `"sa|id i|t was ninety minutes"` and `"st|ill s|ays"` both matched, so any sentence with
   *said*, *did* or *still* near its start was silently dropped as a statement of intent. Same class of bug
   as a bare month prefix matching "market" — openers are word-boundary anchored now.
3. **`"the"` was a factual verb.** Romanised Hindi *"the"* (they were) shares its spelling with the commonest
   word in English, so on many chats the verb gate passed everything. Factual verbs are per-language now,
   and the Hindi past copula is covered by `tha`/`thi`/`thay` instead.

### The change that mattered most

Scoping Rigor to the arguments. Applicability used to be computed once for the whole chat, so one real
argument inside thirty conversations averaged into nothing. It is now decided per episode, and the lens
scores only the conversations where people are both asserting and disagreeing.

On a real three-year chat this took the claim ledger from 112 entries — mostly flat-hunting, `"My stipend
is too low"`, `"I got 1bhk brand new"` — to 103 entries drawn entirely from the two political arguments
buried inside it, and cut "questions nobody answered" from 84 to 44. The lens went from `weak` to fitting.

### Known residual

The five claim-detection errors that remain are evaluative sentences a word list cannot separate from
assertions: *"It is political in every way possible"* against *"It was violence for a political cause"*.
That distinction needs semantics, and it is what the optional local-model tier is for — never the web app,
which stays sealed and heuristic.

The gold set is 77 claim candidates, 20 questions and 9 episodes. That is enough to catch a regression and
not enough to justify a decimal place; treat differences under a few points as noise. The fixture is also
somewhat easier than the real chat it was modelled on — on the real export the question classifier finds
fewer rhetorical questions than a human would, because the rhetorical frames are written for English and
Hindi and not for Bengali.

### The second opinion, and why it is optional

The residual above is what the optional local-model tier is for:

```bash
threadlens analyse chat.txt --deep --backend ollama --model qwen2.5:3b
```

It asks a model running on your own machine the same question the claim gate asks, and prints where the two
disagree. It never decides whether a claim is true, it changes no score, and the heuristic verdict stays
beside its own. It is loopback-only and off by default; the web app cannot reach it at all.

On the hardware this was developed on (4 GB VRAM) the largest model that loads is a 3B, and a 3B is close to
guessing at this task — it disputed `Two officers were suspended in November`, which is unambiguously a claim.
So when agreement falls below 50% the report says outright that the model is the likelier problem. Treat the
disagreement list as somewhere to look, never as a correction to apply.

Re-run `make eval` after any change to the gates or the lexicons. A change that improves a score it was
not aimed at deserves as much suspicion as one that breaks a score it was.

---

## 7. Changing the model

The word lists are the highest-value contribution, especially for Bengali, Tamil, Urdu and other languages.

1. Edit `lexicons/lexicons.json`.
2. Run `make sync` to copy them into the Python package (a test fails if the two drift apart).
3. Run `make test`. If you touched `political_label`, the balance test and the mirror test both have to pass.
4. Never attach a real chat to an issue or a pull request. Synthetic samples only.

If you change a threshold or a formula, change it in **both** `web/src/core.js` and `python/threadlens/`, or
the parity test will fail — which is the point of it.
