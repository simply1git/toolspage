# Media Operations Guide

This guide covers runtime and safety controls for media processing endpoints, including YouTube and platform video downloads.

## Runtime Dependencies

### Core Media Processing
- `FFMPEG_COMMAND` must resolve to a working FFmpeg binary.
- `FFPROBE_COMMAND` must resolve to a working ffprobe binary.
- Keep `FFMPEG_REQUIRED=true` in production so startup fails fast if dependencies are missing.

### YouTube and Platform Downloads
- `YTDLP_BINARY` should resolve to yt-dlp binary (auto-downloaded by library if not found).
- yt-dlp supports 1000+ platforms including YouTube, Vimeo, Dailymotion, Twitter/X, Instagram, TikTok, Pinterest, Twitch, etc.
- No additional runtime dependencies required - yt-dlp-wrap package handles installation automatically.

## Queue Topology

Use split queues to isolate workload classes:

- `PDF_QUEUE_NAME` and `PDF_JOB_CONCURRENCY` for PDF workflows.
- `MEDIA_QUEUE_NAME` and `MEDIA_JOB_CONCURRENCY` for video/audio workflows (uploads + URL downloads).

Recommended baseline:

- Set media concurrency lower than PDF concurrency when CPU is limited.
- Monitor queue depth separately and scale workers based on media queue lag.
- YouTube downloads count against media queue concurrency.

Backpressure controls:

- `PDF_QUEUE_MAX_PENDING` rejects new PDF async jobs when pending jobs reach threshold.
- `MEDIA_QUEUE_MAX_PENDING` rejects new media async jobs when pending jobs reach threshold.
- A value of `0` disables backpressure for that queue.

## Limits and Timeouts

Primary controls:

- `MEDIA_UPLOAD_LIMIT_MB` to cap media file size (both uploads and downloads).
- `MEDIA_MAX_DURATION_SEC` to cap processing duration by content length.
- `FFMPEG_TIMEOUT_MS` to terminate long-running transcodes.
- `FFPROBE_TIMEOUT_MS` to terminate slow metadata probing.
- `YTDLP_TIMEOUT_MS` to cap download operations (default 5 minutes).

Behavior:

- Over upload limit returns `413`.
- Timeout returns `408`.
- Client disconnect cancels processing to free resources.
- Queue saturation returns `429` for async submit endpoints.

## Allowed Formats

Input constraints:

- Video extensions are controlled by `MEDIA_VIDEO_EXTENSIONS`.
- Audio extensions are controlled by `MEDIA_AUDIO_EXTENSIONS`.

Output constraints:

- Audio output formats are controlled by `MEDIA_AUDIO_OUTPUT_FORMATS`.

Use conservative defaults in production and expand only for verified use cases.

## YouTube Download Configuration

### Basic Setup (Personal Use)

```bash
# Enable YouTube/platform downloads
MEDIA_URL_INGEST_ENABLED=true

# Quality preset: low, medium, high
YTDLP_DEFAULT_QUALITY=medium

# Leave allowlist empty to support all platforms
MEDIA_URL_ALLOWLIST=

# Optional: specific binary path
YTDLP_BINARY=yt-dlp

# Optional: restrict by host/platform (comma-separated)
# Examples: youtube.com,vimeo.com,tiktok
MEDIA_URL_ALLOWLIST=
```

Allowlist behavior:

- Matching supports exact host (`youtube.com`), subdomains (`m.youtube.com`), wildcard-style host entries (`*.youtube.com`), or known platform keys (`youtube`, `vimeo`, `tiktok`).
- URL submission endpoint still returns `202` for valid requests; non-allowlisted URLs fail during job execution and are visible as failed jobs via `GET /api/v1/jobs/:jobId`.

### Supported Platforms

yt-dlp automatically detects and downloads from audio/video/live content across 1000+ platforms:

#### Video Platforms
- **YouTube**: Regular videos, shorts, live streams, premieres
- **Vimeo**: Public and password-protected videos
- **Dailymotion**: All public content
- **Twitch**: VODs and clips (live streams with duration limits)
- **Facebook**: Public videos
- **Reddit**: v.redd.it videos

#### Short-Form Video
- **TikTok**: All public videos
- **Instagram**: Reels and regular videos (public only)
- **Pinterest**: Public video pins
- **YouTube Shorts**: Full support
- **Twitter/X**: Native videos and embedded content

#### Audio Platforms
- **SoundCloud**: Tracks and playlists
- **Bandcamp**: Individual tracks
- **Mixcloud**: Shows and mixes

#### Live Streaming
- **Twitch**: Live streams (respects `MEDIA_MAX_DURATION_SEC`)
- **YouTube Live**: Active streams (with automatic time limits)

### Quality Presets

Configure via `YTDLP_DEFAULT_QUALITY`:

- **high**: Best available quality up to 1080p (slower, larger files, ~500MB limit)
- **medium** (recommended): Up to 720p, balanced speed/quality, ~250MB limit
- **low**: Up to 480p, fastest downloads, smallest files, ~100MB limit

The system automatically falls back to lower quality if requested quality is unavailable.

### Error Handling

The system automatically classifies errors and provides actionable feedback:

| Error Type | HTTP Status | Retryable | User Message |
|------------|-------------|-----------|--------------|
| Age Restricted | 403 | No | Video is age-restricted and cannot be downloaded without authentication |
| Private/Members-Only | 403 | No | Video is private or members-only |
| Geo-Restricted | 451 | No | Video not available in your geographic region |
| Removed/Deleted | 410 | No | Video has been removed or deleted |
| Not Found | 404 | No | Video not found |
| Rate Limited | 429 | Yes (1 retry) | Rate limited by platform. Try again later |
| Network Error | 503 | Yes (3 retries) | Network connection error |
| Timeout | 408 | Yes (2 retries) | Download timed out |
| No Format Available | 422 | No | No downloadable formats found for this video |
| File Size Exceeded | 413 | No | Video file size exceeds limit |

Errors are logged with full context for debugging.

### Security Features

Built-in protections:

#### SSRF Prevention
- Blocks internal/private addresses: localhost, 127.0.0.1, 10.x.x.x, 192.168.x.x, 172.16-31.x.x
- Blocks .local domains and IPv6 private ranges
- Only HTTP/HTTPS protocols allowed

#### Resource Protection
- File size limits enforced (`MEDIA_UPLOAD_LIMIT_MB`)
- Download timeouts prevent hung requests
- Client abort signal propagation cancels downloads immediately
- Temporary file cleanup guaranteed

#### Input Sanitization
- Filename sanitization prevents directory traversal
- URL validation prevents command injection
- No shell metacharacters in yt-dlp arguments

#### Platform Detection
Automatic detection of:
- YouTube (including shorts and nocookie domains)
- Vimeo, Dailymotion, Twitter/X, Instagram, TikTok, Pinterest
- Twitch, Reddit, Facebook, SoundCloud
- Generic video URLs as fallback

### Production Considerations

#### For Public Deployment

If making this available to external users:

1. **Set explicit allowlist**
   ```bash
   # Only allow specific trusted platforms
   MEDIA_URL_ALLOWLIST=youtube.com,youtu.be,vimeo.com
   ```

2. **Require rights confirmation**
   ```bash
   MEDIA_REQUIRE_RIGHTS_CONFIRMATION=true
   ```

3. **Limit concurrency** Start conservatively:
   ```bash
   MEDIA_JOB_CONCURRENCY=1
   ```

4. **Monitor logs** Watch for:
   - High failure rates on specific domains
   - Unusual download patterns
   - Repeated 429 rate limit errors

5. **Review Terms of Service** Understand platform policies for your jurisdiction.

#### For Personal Use

Current default configuration is optimized for single-user personal use:

- All platforms enabled (empty allowlist)
- Medium quality for speed/size balance
- Generous timeout (5 minutes)
- Automatic retry on transient failures

## Verification Commands

```bash
# Run all tests including media/download tests
npm test

# Full CI pipeline with smoke tests
npm run ci

# Manual YouTube download test
curl -X POST http://localhost:8080/api/v1/jobs/video-to-mp3-url \
  -H "Content-Type: application/json" \
  -d '{
    "sourceUrl": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "rightsConfirmed": true,
    "bitrateKbps": "192"
  }'
```

Manual checks:

```bash
# Verify yt-dlp is accessible
yt-dlp --version

# Test ffmpeg
ffmpeg -version

# Check queue status
curl http://localhost:8080/api/v1/info/status
```

## Troubleshooting

### "Download failed: No downloadable formats found"

- Video may require authentication
- Check if video is geo-restricted
- Try different quality preset
- Verify video URL is publicly accessible

### "Rate limited by platform"

- Platform has throttled your IP
- Wait 60 seconds and retry
- Consider using lower quality preset (faster downloads)

### "Download timed out"

- Video may be very large
- Increase `YTDLP_TIMEOUT_MS`
- Use lower quality preset

### "yt-dlp binary not found"

- Install manually: `pip install yt-dlp` or download from GitHub
- Set explicit path: `YTDLP_BINARY=/path/to/yt-dlp`
- Library will attempt auto-download on first use

## Best Practices

1. **Start with medium quality** - balances speed, size, and quality
2. **Monitor disk space** - downloads are cleaned up but temp files can accumulate during processing
3. **Set reasonable timeouts** - 5 minutes should cover most videos, increase for longer content
4. **Use async endpoints** for videos >30 seconds to avoid HTTP timeout
5. **Log download metrics** - track success rates, platforms, file sizes
6. **Keep yt-dlp updated** - platforms change frequently, regular updates maintain compatibility
