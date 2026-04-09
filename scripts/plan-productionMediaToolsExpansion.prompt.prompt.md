## Plan: Production Media Tools Expansion

Add a hardened media processing layer on top of the existing API/queue/storage architecture by shipping three upload-based tools (Video Compress, Video to MP3, Audio Convert) plus a tightly controlled, owned-content URL ingestion path behind a feature flag. This reuses the current async job model, output store, and frontend tool patterns while adding explicit rights attestations, FFmpeg runtime enforcement, and operational guardrails.

**Steps**
1. Phase 1 - Backend media core (*blocks all later phases*): add `server/media.js` with validated processing functions for `compressVideo`, `videoToMp3`, and `convertAudio`; enforce file-type checks, rights confirmation, and max duration; run malware scan hooks before transforms; standardize output metadata (`outputName`, `contentType`, `stats`).
2. Phase 1 - Runtime/config hardening (*parallel with step 1*): extend `server/config.js` and env templates with FFmpeg/FFprobe command paths, media duration limits, allowed formats, and URL-ingest feature flags; add startup validation so API/worker fail fast when FFmpeg is required but unavailable.
3. Phase 2 - API and queue integration (*depends on 1,2*): wire sync routes and async job routes in `server/index.js` for `video-compress`, `video-to-mp3`, and `audio-convert`; include rights fields in payloads; ensure download endpoint uses `job.result.contentType` generically for all tool types.
4. Phase 2 - Worker handlers (*depends on 1,2*): extend `server/queue-handlers.js` to register the 3 media handlers and persist outputs via existing output store; return compression stats for video-compress headers/telemetry.
5. Phase 3 - Optional owned-content URL ingestion (*depends on 1,2,3,4*): add a feature-flagged endpoint and queue type for URL-based ingestion restricted to explicit ownership confirmation, allowlisted domains, and strict rate/size/duration limits; default disabled in all environments.
6. Phase 4 - Frontend tool UX (*depends on 3,4; parallel across pages*): create `tools/video-compress.html`, `tools/video-to-mp3.html`, `tools/audio-convert.html` and corresponding scripts in `assets/js/`; reuse async threshold flow from existing PDF tools and add rights attestation controls in form UX.
7. Phase 4 - Discovery/catalog updates (*depends on 6*): update `index.html` categories, tool count, and tool cards to include media tools; keep trust section aligned with rights-safe messaging.
8. Phase 5 - Docs/tests/ops (*depends on 3,4,5,6,7*): update `README.md`, `docs/implementation-status.md`, `.env.example`, and `production.env.example`; add API tests for new routes (validation and happy-path with mocked processor), then run `npm test` and `npm run ci`.

**Relevant files**
- `e:/project/toolspage/server/index.js` - add media sync/job routes, config exposure, and generic download handling for media content types.
- `e:/project/toolspage/server/queue-handlers.js` - register queue handlers for media job types.
- `e:/project/toolspage/server/config.js` - add FFmpeg/media/url-ingest config flags and limits.
- `e:/project/toolspage/server/services.js` - reference existing validation and error-shaping patterns for parity.
- `e:/project/toolspage/server/security.js` - reuse command execution and malware scan hooks.
- `e:/project/toolspage/server/job-payload.js` - ensure payload options include rights and media settings consistently.
- `e:/project/toolspage/server/test/api.test.js` - add coverage for media endpoint behavior.
- `e:/project/toolspage/index.html` - add media category and new tool cards.
- `e:/project/toolspage/tools/video-compress.html` - new media tool page.
- `e:/project/toolspage/tools/video-to-mp3.html` - new media tool page.
- `e:/project/toolspage/tools/audio-convert.html` - new media tool page.
- `e:/project/toolspage/assets/js/video-compress.js` - async client flow for video compression.
- `e:/project/toolspage/assets/js/video-to-mp3.js` - async client flow for extraction.
- `e:/project/toolspage/assets/js/audio-convert.js` - async client flow for format conversion.
- `e:/project/toolspage/README.md` - update tool list, API endpoints, and media runtime requirements.
- `e:/project/toolspage/.env.example` - add media and URL-ingest environment keys.
- `e:/project/toolspage/production.env.example` - production-safe defaults and feature-flag guidance.
- `e:/project/toolspage/docs/implementation-status.md` - reflect completed media capability and remaining gaps.

**Verification**
1. Unit/API checks: run `npm test` and confirm new tests cover missing rights confirmation, unsupported format, and successful queue submission for media tools.
2. Integration checks: run `npm run ci` and verify smoke/status/metrics still pass with media config enabled.
3. Runtime checks: start API/worker with FFmpeg installed and confirm both start cleanly; verify startup fails when FFmpeg is required and not present.
4. Functional checks: upload test files for each new tool in both sync and async paths; validate output MIME/types, filenames, and compression ratio headers where applicable.
5. Safety checks: verify URL ingestion is disabled by default; when enabled, test only allowlisted domains and ownership attestation requirement.

**Decisions**
- Include scope: upload-based media tools (`video-compress`, `video-to-mp3`, `audio-convert`) and owned-content URL ingestion behind explicit feature flag.
- Rights model: require user attestation for all media transforms; reject requests without confirmation.
- Runtime model: FFmpeg is required and should fail startup if missing.
- Format scope (v1): include MP3, WAV, AAC, OGG, and M4A outputs for audio conversion.
- Excluded for this iteration: DRM circumvention, unrestricted downloader UX, and broad crawler-style media scraping.

**Further Considerations**
1. URL ingestion backend choice recommendation: Option A `yt-dlp` feature-flagged adapter with strict allowlist, Option B no ingestion in backend and only upload mode, Option C external partner API with compliance controls.
2. Throughput tuning recommendation: Option A keep `JOB_CONCURRENCY=2` default, Option B auto-scale by CPU count with queue depth guardrails, Option C separate queue names for PDF vs media workloads.
3. Storage policy recommendation: Option A keep current retention window for all outputs, Option B shorter TTL for media outputs, Option C policy-driven TTL per tool type.
