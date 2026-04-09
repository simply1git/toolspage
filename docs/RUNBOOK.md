# Toolspage Runbook

## 1. Deployment Model
- API service: handles HTTP requests, enqueues async jobs.
- Worker service: consumes async jobs and writes outputs to storage.
- Redis: queue backend and distributed rate limit backend.
- Object storage: local disk (dev) or S3/MinIO (prod).

## 2. Pre-Deployment Checklist
- Copy `production.env.example` to a secure `.env` and fill secrets.
- Set a strong `API_KEY`.
- Set strict `CORS_ORIGINS`.
- Ensure Redis is reachable from API and worker.
- Ensure output storage credentials are valid.
- Run validation locally:
  - `npm install`
  - `npm run ci`

## 3. Production Start
### Docker Compose
```bash
docker compose --env-file .env up -d --build
```

### Verify Health
```bash
curl -fsS http://localhost:8080/api/v1/info/status
curl -fsS http://localhost:8080/api/v1/metrics
```

## 4. Scale Worker Capacity
- Increase worker replicas when queue depth grows.
- Compose example:
```bash
docker compose up -d --scale toolspage-worker=3
```

## 5. Observability
- Primary health: `/api/v1/info/status`
- Metrics: `/api/v1/metrics`
- Key signals:
  - `toolspage_jobs_queued`
  - `toolspage_jobs_running`
  - `toolspage_jobs_failed`
- Logs should be centralized from API + worker + redis.

## 6. Common Incidents
### Queue Backlog Growing
- Check Redis reachability and worker count.
- Increase worker replicas.
- Lower `JOB_CONCURRENCY` if CPU saturation causes failures.

### Elevated 429 Responses
- Verify distributed limiter is on (`DISTRIBUTED_RATE_LIMIT=true`).
- Review abusive client IPs.
- Tune `RATE_LIMIT_MAX` and `RATE_LIMIT_WINDOW_MS`.

### OCR Failures
- Verify `OCR_PROVIDER` and API key.
- Confirm outbound internet access to OCR provider.
- Fallback behavior: text extraction from digital PDF only.

### Compression Failures (Ghostscript)
- Verify `GHOSTSCRIPT_COMMAND` exists in runtime image.
- Temporarily switch to `COMPRESS_ENGINE=pdf-lib`.

### Malware Scan Failures
- If `ENABLE_CLAM_SCAN=true`, verify `clamscan` binary and signatures.
- Temporarily disable scan only if risk-approved by security team.

## 7. Rollback Plan
- Roll back to last known stable image tag.
- Keep Redis + storage untouched to preserve queued data/outputs.
- Re-run health and metrics checks after rollback.

## 8. Data Retention
- Outputs are cleaned by retention timer (`OUTPUT_RETENTION_SEC`) for local storage.
- Audit events are appended to `OUTPUT_AUDIT_LOG_PATH`.
- For S3 lifecycle, configure bucket policy/lifecycle rules at storage layer.

## 9. Security Minimums
- Enforce HTTPS at ingress.
- Keep `API_KEY` secret and rotate periodically.
- Restrict `CORS_ORIGINS` to known domains.
- Enable distributed rate limiting in multi-instance deployments.
- Store secrets in a secret manager, not git.

## 10. Release Gate
- CI must pass:
  - tests
  - smoke checks
  - audit
  - docker build
