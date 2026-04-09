# Deploying Toolspage on Render + Cloudflare (Free-First)

## 1) Render Services

Use the provided `render.yaml` blueprint:

- `toolspage-api` (web service, Docker)
- `toolspage-worker` (worker service, Docker command `node server/worker.js`)
- `toolspage-redis` (Redis)

## 2) Required Environment Variables

Set these in Render dashboard (do not commit secrets):

- `API_KEY` (long random string)
- `OUTPUT_SIGNING_SECRET` (long random string, distinct from API key)
- `CORS_ORIGINS` (Cloudflare frontend domain list)
- `MEDIA_URL_ALLOWLIST` (domain allowlist)
- Optional hardening:
  - `STRICT_PRODUCTION_CONFIG=true`
  - `ALLOW_IN_MEMORY_QUEUE_FALLBACK=false`
  - `YTDLP_ALLOW_INSECURE_TRANSPORT=false`

## 3) Cloudflare Setup

- Point domain DNS to Render app.
- Enable HTTPS and "Always Use HTTPS".
- Add basic WAF/rate-limit rules for `/api/*`.
- Keep cache conservative for API paths (`/api/*` bypass cache).

## 4) Health Verification

After deploy:

- `GET /api/v1/info/status`
- `GET /api/v1/metrics`
- UI pages load and complete at least one async job end-to-end.

## 5) Production Safety Checklist

- API key required and enforced.
- CORS restricted to known origins.
- Signed output URL secret configured.
- Redis reachable by both API and worker.
- Worker running separately from API.
