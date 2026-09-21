# Self-hosted Threadlens API. Stateless: nothing is written to disk.
FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY README.md /README.md
COPY python/ /app/
RUN pip install --no-cache-dir ".[server]" && useradd -r -u 10001 tl
USER tl
EXPOSE 8000
# Add ".[server,deep]" above and THREADLENS_DEEP=1 for ML models (large image).
CMD ["uvicorn", "threadlens.server:app", "--host", "0.0.0.0", "--port", "8000", "--no-access-log", "--proxy-headers"]
