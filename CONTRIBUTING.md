# Contributing

Thanks for helping. A few rules keep the project private and fair.

- **Never commit or attach real chats**, including screenshots. Write synthetic examples in `samples/`.
- **Word lists** live in `lexicons/lexicons.json` and are shared by the web app and the Python package. After editing, run `make sync && make test`.
- **Symmetry:** every metric must be computed the same way for every participant, and findings must name both sides.
- **No network calls** in `web/src/`. The build's CSP will block them anyway.
- Keep `web/src/core.js` and `python/threadlens/metrics.py` in step. The tests check both against the sample.

```bash
make test    # JS + Python tests
make build   # dist/index.html
```
