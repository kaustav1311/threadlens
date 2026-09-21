# Threadlens: notes for Claude Code

## What this is
Private WhatsApp-chat analysis. The web app runs 100% in the browser, and the built page blocks all network access via CSP.
The Python package mirrors the same scoring for the CLI, a self-hosted API, and optional local ML models.

## Architecture
```
            ┌──────────────── lexicons/*.json (single source of truth for word lists) ────────────────┐
            │                                                                                        │
 web/src/core.js  (parse → score → findings → markdown; UMD, no deps, runs in browser + Node)        │
 web/src/app.js   (UI: file/zip/docx/paste → core → render panels/SVG charts)                        │
 web/src/body.html + style.css                                                                       │
 web/vendor/jszip.min.js                                                                             │
        │                                                                                            │
 scripts/build.mjs ──► dist/index.html             full page, CSP: connect-src 'none', script hashes │
                  └──► dist/threadlens-artifact.html  body fragment for artifact hosts (no downloads) │
                                                                                                     │
 python/threadlens/  parser.py · metrics.py · report.py (mirror core.js) ◄── data/*.json (make sync) ┘
                     deep.py   (Detoxify + fallacy classifiers, local, optional extra [deep])
                     cli.py    (`threadlens analyse|serve`)
                     server.py (FastAPI, in-memory per-IP rate limits, 10 MB cap, no disk, no body logs)
```
Data flow: export text → `parseChat` (Android/iOS, 12/24h, date-order detection) → messages → `analyse` (per-person
counts, per-100-word rates, heat, sentiment, moral words, rhetoric regexes, reply times, day series) → `findings(lens)`
(symmetric comparisons, off below 150 words/person) → UI or Markdown/JSON.

## Commands
- `make test`: JS tests (`node --test "web/test/*.test.js"`) + Python tests (`cd python && pytest`)
- `make build`: dist files. Rebuild before committing UI changes; dist is committed so the page works offline.
- `make sync`: copy lexicons into python/threadlens/data (a test fails if they drift)
- `threadlens serve`: API at http://127.0.0.1:8000/docs

## Invariants (do not break)
1. **No network from the web app.** Nothing in web/src may fetch, load fonts or use a CDN. The CSP in build.mjs must keep `connect-src 'none'`.
2. **Symmetry.** Every metric is computed identically for every participant. Findings name both sides and the size of the gap.
3. **No diagnosis, no ideology.** Never output personality, IQ or mental-health labels. Political word lists must cover labels from *all* sides equally, and no score may reward or penalise a political position, only argumentative conduct.
4. **JS ↔ Python parity.** Same thresholds and formulas in core.js and metrics.py. Extend the tests when you add a metric.
5. **No real chats** in the repo, issues or fixtures. Only synthetic samples in samples/.
6. `prefers-reduced-motion` must disable all animation.

## Deployment
- **Web:** push to `main` → `.github/workflows/pages.yml` runs tests, builds, and deploys `dist/index.html` to GitHub Pages
  (one-time: repo Settings → Pages → Source = GitHub Actions). URL: https://kaustav1311.github.io/threadlens/
- **API (optional):** `docker build -t threadlens . && docker run -p 8000:8000 -e THREADLENS_RATE_PER_MIN=5 threadlens`,
  behind HTTPS (Caddy, Fly.io, Render or Cloud Run). Set `THREADLENS_TRUST_PROXY=1` only behind your own proxy.
- **Artifact copy:** dist/threadlens-artifact.html can be re-published to claude.ai from a Cowork session.

## Next work
See docs/HANDOFF.md.
