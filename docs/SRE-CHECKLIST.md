# SRE Checklist

## Before Go-Live
- [ ] `production.env.example` copied to secure `.env`
- [ ] `API_KEY` rotated from placeholder
- [ ] `CORS_ORIGINS` restricted to production domains
- [ ] `RUN_QUEUE_WORKER_IN_API=false` for split topology
- [ ] Redis health verified
- [ ] S3/MinIO write/read verified
- [ ] `npm run ci` passed on release commit

## Monitoring Thresholds
- [ ] Alert when `toolspage_jobs_queued > 100` for 5 minutes
- [ ] Alert when `toolspage_jobs_failed > 0` spike sustained 10 minutes
- [ ] Alert when `/api/v1/info/status` is unavailable > 1 minute

## Security Review
- [ ] HTTPS termination enabled
- [ ] API key stored in secret manager
- [ ] Malware scan policy decision documented
- [ ] OCR provider usage approved

## Backup/Recovery
- [ ] Redis persistence or managed Redis policy reviewed
- [ ] Object storage retention/lifecycle reviewed
- [ ] Rollback image tags documented
