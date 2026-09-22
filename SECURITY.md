# Security

## Reporting a vulnerability

Use GitHub's **Report a vulnerability** button on the Security tab of
[kaustav1311/threadlens](https://github.com/kaustav1311/threadlens/security). Please do not open a public
issue for a security problem, and **never attach a real chat log** to a report — a synthetic reproduction is
always enough.

Expect an acknowledgement within a week. There is no bounty; this is an unfunded open-source project.

## Threat model

Threadlens has no server, no database, no account system and no user data at rest, which removes most of the
usual attack surface. What remains:

| Threat | Mitigation |
|---|---|
| **The page exfiltrates a chat** | The built page ships `Content-Security-Policy: default-src 'none'; connect-src 'none'; font-src 'none'`. The browser refuses the connection even if the code attempted one. `web/test/build.test.js` fails the build if the CSP weakens, if any source file calls `fetch`/`XMLHttpRequest`/`sendBeacon`, or if a remote script, stylesheet or font appears. |
| **Injected third-party script** | Every script is inline and pinned by SHA-256 hash in the CSP. There are no runtime dependencies, no CDN and no package manager in the browser build. JSZip is vendored into the repo and hashed like everything else. |
| **Supply chain via GitHub Actions** | Every action is pinned to a full commit SHA, not a tag. A tag can be repointed by its owner; a SHA cannot. Workflows run with `permissions: contents: read` (plus the minimum Pages scopes on the deploy job) and `persist-credentials: false`. |
| **Compromised repo serving malicious JS** | The site is rebuilt from source in CI on every deploy rather than served from a committed artifact, and CI fails if the committed `dist/` does not match the sources. Protect the `main` branch and keep 2FA on the account. |
| **XSS from chat content** | Message text is inserted with `textContent` / `document.createTextNode`, never `innerHTML`. A chat containing `<script>` is displayed as characters. |
| **Zip bomb / malformed upload** | 25 MB and 250,000-message caps, both enforced before analysis. Parsing is linear and allocates no more than the file size. |
| **Denial of service** | There is nothing to deny: GitHub Pages serves a static file. The in-page limit of 8 analyses per 10 minutes exists only to protect the user's own browser. |
| **Self-hosted API abuse** | Optional and off by default. When run, it enforces per-IP rate limits (5/min, 100/day), a 10 MB cap, writes nothing to disk and logs no request bodies. Only set `THREADLENS_TRUST_PROXY=1` behind a proxy you control, or the limits can be bypassed with a forged header. |

## If you self-host

- Serve over HTTPS and let the page keep its own CSP; do not weaken it to add analytics.
- The single `dist/index.html` needs no server-side code. If your host injects scripts or tag managers, the
  CSP will block them and the page will still work — that is the intended behaviour, not a bug.
- Do not put the optional API on the public internet without a reverse proxy, TLS and its rate limits on.

## What this project will never do

Add analytics, a beacon, telemetry, an account system, or any code path that transmits a chat anywhere. A
pull request that adds one will fail the test suite, and would not be merged if it didn't.
