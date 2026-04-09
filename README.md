# Toolspage

Toolspage is a mobile-first utility hub for common file tasks.

Core capabilities include PDF/image utilities, media conversion with FFmpeg, and URL-based video/audio download workflows powered by yt-dlp.

## Quick Start

```bash
cp .env.example .env
docker compose up --build
```

Then open `http://localhost:8080`.

This starts both `toolspage` and `redis` by default for persistent queueing.
It also starts a dedicated `toolspage-worker` service for queue execution.

## Local Operations

Common startup commands:

```bash
# Standard start
npm start

# Clean start: clears any stale listener on PORT before boot
npm run start:clean
```

Quick health check:

```bash
curl http://localhost:8080/api/v1/info/status
```

Quick CORS check:

```bash
curl -H "Origin: http://example.com" http://localhost:8080/api/v1/config
```

## Release Verification

Before shipping, run this sequence:

1. `npm run ci`
2. `npm run start:clean`
3. Verify `GET /api/v1/info/status` returns `ok: true`
4. Verify downloader pages load from `http://localhost:8080`:
	- `tools/video-downloader.html`
	- `tools/pinterest-downloader.html`
	- `tools/tiktok-downloader.html`
5. Verify URL ingestion and CORS are set as intended for environment:
	- Dev: open defaults acceptable
	- Prod: set explicit `CORS_ORIGINS` and `MEDIA_URL_ALLOWLIST`

## Frontend Tools

- PDF to Word
- PDF to JPG
- Word to PDF
- JPG to PDF
- Merge PDF
- Compress PDF
- Compress Image
- Resize Image
- Remove Background
- QR Generator
- OCR Extract
- Video Compress
- Video to MP3
- Audio Convert
- YouTube Downloader
- Pinterest Downloader
- TikTok Downloader
- YouTube Thumbnail Downloader

## API Endpoints

- `GET /api/v1/info/status` - health status
- `GET /api/v1/metrics` - Prometheus-style process and job metrics
- `GET /api/v1/config` - safe runtime limits
- `POST /api/v1/tools/pdf-to-word` - multipart form-data (`file`, `ocrMode`, `language`)
- `POST /api/v1/tools/compress-pdf` - multipart form-data (`file`, `preset`, `quality`)
- `POST /api/v1/jobs/pdf-to-word` - async job submit for large files
- `POST /api/v1/jobs/compress-pdf` - async job submit for large files
- `POST /api/v1/tools/video-compress` - multipart form-data (`file`, `quality`, `bitrateKbps`, `rightsConfirmed`)
- `POST /api/v1/tools/video-to-mp3` - multipart form-data (`file`, `bitrateKbps`, `rightsConfirmed`)
- `POST /api/v1/tools/audio-convert` - multipart form-data (`file`, `targetFormat`, `bitrateKbps`, `rightsConfirmed`)
- `POST /api/v1/jobs/video-compress` - async media compression submit
- `POST /api/v1/jobs/video-to-mp3` - async media extraction submit
- `POST /api/v1/jobs/audio-convert` - async audio conversion submit
- `POST /api/v1/jobs/video-to-mp3-url` - feature-flagged YouTube and 1000+ platform download with yt-dlp (`sourceUrl`, `rightsConfirmed`, `bitrateKbps`, optional `quality`)
- `POST /api/v1/jobs/video-download-url` - unified URL downloader (`sourceUrl`, `mode`, `quality`, playlist/subtitle format options)
- `POST /api/v1/jobs/video-download-inspect` - URL metadata inspection route
- `GET /api/v1/jobs/:jobId/progress` - SSE progress feed (includes stage and fine-grained download percentages)
- `GET /api/v1/jobs/:jobId` - async job status
- `GET /api/v1/jobs/:jobId/download` - async job output download
- `GET /api/v1/outputs/:storageKey` - local-storage output fetch (API-key protected)

## Production Controls

- `helmet` security headers
- CORS enabled by default for all origins (set `CORS_ORIGINS` to restrict allowed origins)
- Request ID propagation (`x-request-id`)
- IP-based API rate limiting
- Strict upload size limits (`FILE_UPLOAD_LIMIT_MB`)
- Async in-memory job queue for larger files with polling endpoints
- Optional Redis persistent queue backend (`REDIS_URL`)
- Split Redis queue topology for PDF and media workloads
- Dedicated worker process support (`npm run start:worker`)
- Async output persistence with local or S3-compatible object storage
- Optional distributed Redis rate limiting across API instances
- Optional OCR provider integration for scanned PDF extraction
- Optional Ghostscript compression engine and malware scan hooks
- Required FFmpeg/FFprobe runtime checks for media pipelines
- FFmpeg/ffprobe process timeouts and media-specific upload size caps
- Queue backpressure guardrails for async submissions
- Media rights attestation enforcement for processing routes
- Optional YouTube and 1000+ platform downloads via yt-dlp with allowlist enforcement, quality presets, and intelligent error classification
- Output retention cleanup and audit logging for local storage
- Optional API key protection for processing routes (`API_KEY`)
- Structured HTTP logging with sensitive header redaction
- Docker health check against API status endpoint

## Environment Variables

See `.env.example`.

Key settings:
- `PORT`
- `CORS_ORIGINS`
- `FILE_UPLOAD_LIMIT_MB`
- `RATE_LIMIT_MAX`
- `RATE_LIMIT_WINDOW_MS`
- `TRUST_PROXY`
- `ASYNC_THRESHOLD_MB`
- `JOB_TTL_MS`
- `JOB_CLEANUP_MS`
- `JOB_CONCURRENCY`
- `PDF_JOB_CONCURRENCY`
- `MEDIA_JOB_CONCURRENCY`
- `PDF_QUEUE_MAX_PENDING`
- `MEDIA_QUEUE_MAX_PENDING`
- `API_KEY`
- `REDIS_URL`
- `QUEUE_NAME`
- `PDF_QUEUE_NAME`
- `MEDIA_QUEUE_NAME`
- `REDIS_CONNECT_TIMEOUT_MS`
- `RUN_QUEUE_WORKER_IN_API`
- `DISTRIBUTED_RATE_LIMIT`
- `STORAGE_PROVIDER`
- `OUTPUT_LOCAL_DIR`
- `OUTPUT_PUBLIC_BASE_URL`
- `SIGNED_URL_TTL_SEC`
- `OUTPUT_RETENTION_SEC`
- `OUTPUT_AUDIT_LOG_PATH`
- `S3_BUCKET`
- `S3_REGION`
- `S3_ENDPOINT`
- `S3_FORCE_PATH_STYLE`
- `S3_ACCESS_KEY_ID`
- `S3_SECRET_ACCESS_KEY`
- `OCR_PROVIDER`
- `OCR_SPACE_API_KEY`
- `COMPRESS_ENGINE`
- `GHOSTSCRIPT_COMMAND`
- `ENABLE_CLAM_SCAN`
- `CLAMSCAN_COMMAND`
- `FFMPEG_COMMAND`
- `FFPROBE_COMMAND`
- `FFMPEG_REQUIRED`
- `FFMPEG_TIMEOUT_MS`
- `FFPROBE_TIMEOUT_MS`
- `MEDIA_UPLOAD_LIMIT_MB`
- `MEDIA_MAX_DURATION_SEC`
- `MEDIA_REQUIRE_RIGHTS_CONFIRMATION`
- `MEDIA_VIDEO_EXTENSIONS`
- `MEDIA_AUDIO_EXTENSIONS`
- `MEDIA_AUDIO_OUTPUT_FORMATS`
- `MEDIA_URL_INGEST_ENABLED`
- `MEDIA_URL_ALLOWLIST`
- `YTDLP_BINARY`
- `YTDLP_TIMEOUT_MS`
- `YTDLP_DEFAULT_QUALITY`
- `YTDLP_PLAYLIST_MAX_ITEMS`

## Project Structure

- `index.html` - homepage and tool directory
- `tools/` - individual tool pages
- `assets/css/styles.css` - global styles and responsive layout
- `assets/js/` - shared and tool-specific scripts
- `server/` - production API service
- `docs/toolspage-mvp-prd.md` - product requirements
- `docs/toolspage-deepdive-research-2026-03-09.md` - research baseline
- `docs/RUNBOOK.md` - production operations runbook
- `docs/SRE-CHECKLIST.md` - go-live and monitoring checklist
- `docs/MEDIA-OPERATIONS.md` - media-specific runtime, limits, and safety checklist
- `docs/DEPLOY-RENDER-CLOUDFLARE.md` - free-first production deployment blueprint
- `production.env.example` - production-grade environment template

## Notes

- Client-side analytics events are stored in `localStorage` under `toolspage_analytics`.
- OCR mode toggle for PDF to Word is currently metadata-only and does not run OCR server-side.
- For enterprise-grade PDF compression quality and scanned-PDF DOCX fidelity, add dedicated engines (Ghostscript/OCR pipeline).
- URL ingestion is enabled by default and should be restricted with allowlists for rights-cleared sources in production.
- GitHub Actions workflow is available at `.github/workflows/ci.yml` and runs test + smoke + audit + docker build.
