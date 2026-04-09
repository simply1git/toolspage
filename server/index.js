const path = require("path");
const crypto = require("crypto");
const express = require("express");

const config = require("./config");
const logger = require("./logger");
const {
  helmetMiddleware,
  corsMiddleware,
  pinoMiddleware,
  requestIdMiddleware,
  rateLimiter,
  apiKeyMiddleware,
  upload,
  uploadMedia,
  uploadErrorHandler,
  notFoundHandler,
  errorHandler,
} = require("./middlewares");
const { convertPdfToDocx, compressPdf } = require("./services");
const { compressVideo, videoToMp3, convertAudio, downloadMediaFromUrl, inspectImageFromUrl, ensureMediaRuntime } = require("./media");
const { createJobManager } = require("./jobs");
const { buildQueuedFilePayload } = require("./job-payload");
const { createOutputStore } = require("./output-store");
const { createQueueHandlers } = require("./queue-handlers");
const { startStorageJanitor } = require("./cron");

const MEDIA_JOB_TYPES = new Set(["video-compress", "video-to-mp3", "audio-convert", "video-to-mp3-url", "video-download-url"]);

function buildAbortSignal(req, res) {
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) {
      controller.abort();
    }
  };

  req.on("aborted", abort);

  // Only abort work when the response stream closes before completion,
  // which indicates the client disconnected mid-request.
  res.on("close", () => {
    if (!res.writableEnded) {
      abort();
    }
  });

  return controller.signal;
}

function mergeStats(pdfStats, mediaStats) {
  const backends = [pdfStats.backend, mediaStats.backend];
  return {
    backend: backends[0] === backends[1] ? backends[0] : "mixed",
    pdf: pdfStats,
    media: mediaStats,
    total: pdfStats.total + mediaStats.total,
    queued: pdfStats.queued + mediaStats.queued,
    running: pdfStats.running + mediaStats.running,
    succeeded: pdfStats.succeeded + mediaStats.succeeded,
    failed: pdfStats.failed + mediaStats.failed,
    workersBusy: (pdfStats.workersBusy || 0) + (mediaStats.workersBusy || 0),
  };
}

function isQueueOverloaded(stats, maxPending) {
  if (!Number.isFinite(maxPending) || maxPending <= 0) {
    return false;
  }
  const pending = (stats.queued || 0) + (stats.running || 0);
  return pending >= maxPending;
}

const DOWNLOAD_MODES = new Set(["video", "audio", "metadata"]);
const VIDEO_FORMATS = new Set(["mp4", "webm", "mkv"]);
const AUDIO_FORMATS = new Set(["mp3", "m4a", "aac", "wav", "ogg"]);
const SUBTITLE_FORMATS = new Set(["vtt", "srt"]);

function toBool(value) {
  if (typeof value === "boolean") {
    return value;
  }
  const normalized = String(value || "").toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on";
}

function normalizeStringArray(input) {
  if (Array.isArray(input)) {
    return input.map((item) => String(item || "").trim()).filter(Boolean);
  }
  if (typeof input === "string") {
    return input.split(",").map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

function isApiKeyAuthorized(req) {
  if (!config.apiKey) {
    return true;
  }
  const provided = String(req.header("x-api-key") || req.query.apiKey || "");
  const expected = String(config.apiKey || "");
  const providedBuf = Buffer.from(provided, "utf8");
  const expectedBuf = Buffer.from(expected, "utf8");
  return providedBuf.length === expectedBuf.length && crypto.timingSafeEqual(providedBuf, expectedBuf);
}

function normalizeDownloaderRequest(body, config, opts = {}) {
  const inspectOnly = Boolean(opts.inspectOnly);
  const sourceUrl = String((body && body.sourceUrl) || "").trim();
  if (!sourceUrl) {
    const err = new Error("Source URL required");
    err.status = 400;
    throw err;
  }

  // Support both new canonical qualityProfile and legacy quality values
  const CANONICAL_PROFILES = new Set([
    "4k60", "4k", "1440p60", "1440p", "1080p60", "1080p", "720p60", "720p", "480p",
    "audio-high", "audio-medium", "audio-low",
    // Legacy values (for backward compatibility)
    "high", "medium", "low"
  ]);

  const LEGACY_QUALITY_MAP = {
    "high": "1080p",
    "medium": "720p",
    "low": "480p"
  };

  let quality = String(body && body.qualityProfile || body && body.quality || config.ytdlpDefaultQuality || "720p").toLowerCase();
  if (!CANONICAL_PROFILES.has(quality)) {
    const err = new Error("Invalid quality. Supported: 4k60, 4k, 1440p60, 1440p, 1080p60, 1080p, 720p60, 720p, 480p, audio-high, audio-medium, audio-low");
    err.status = 400;
    throw err;
  }

  // Map legacy quality to canonical profile
  if (LEGACY_QUALITY_MAP[quality]) {
    quality = LEGACY_QUALITY_MAP[quality];
  }

  // Infer mode from quality profile or explicit mode
  let mode = inspectOnly ? "metadata" : String((body && body.mode) || "video").toLowerCase();
  
  // If qualityProfile starts with "audio-", override mode to audio
  if (String(body && body.qualityProfile || "").toLowerCase().startsWith("audio-")) {
    mode = "audio";
  }

  if (!DOWNLOAD_MODES.has(mode)) {
    const err = new Error("Invalid mode. Supported: video, audio, metadata");
    err.status = 400;
    throw err;
  }

  const videoFormat = String((body && body.videoFormat) || "mp4").toLowerCase();
  if (!VIDEO_FORMATS.has(videoFormat)) {
    const err = new Error("Invalid videoFormat. Supported: mp4, webm, mkv");
    err.status = 400;
    throw err;
  }

  const audioFormat = String((body && body.audioFormat) || "mp3").toLowerCase();
  if (!AUDIO_FORMATS.has(audioFormat)) {
    const err = new Error("Invalid audioFormat. Supported: mp3, m4a, aac, wav, ogg");
    err.status = 400;
    throw err;
  }

  const subtitleFormat = String((body && body.subtitleFormat) || "vtt").toLowerCase();
  if (!SUBTITLE_FORMATS.has(subtitleFormat)) {
    const err = new Error("Invalid subtitleFormat. Supported: vtt, srt");
    err.status = 400;
    throw err;
  }

  // Auto-detect playlist vs single video
  let allowPlaylist = false;
  if (body && typeof body.allowPlaylist !== "undefined") {
    allowPlaylist = toBool(body.allowPlaylist);
  } else if (sourceUrl) {
    // Detect playlist by common YouTube playlist patterns
    const playlistPatterns = [
      /[?&]list=([a-zA-Z0-9_-]+)/i,
      /youtube\.com\/playlist\?/i
    ];
    allowPlaylist = playlistPatterns.some((pat) => pat.test(sourceUrl));
  }

  const requestedMaxItems = Number.parseInt((body && body.playlistMaxItems) || "", 10);
  const playlistMaxItems = Number.isFinite(requestedMaxItems) && requestedMaxItems > 0
    ? Math.min(requestedMaxItems, config.ytdlpPlaylistMaxItems)
    : config.ytdlpPlaylistMaxItems;

  return {
    sourceUrl,
    options: {
      rightsConfirmed: body && body.rightsConfirmed,
      mode,
      quality,
      allowPlaylist,
      playlistMaxItems,
      videoFormat,
      audioFormat,
      includeSubtitles: toBool(body && body.includeSubtitles),
      subtitleFormat,
      subtitleLanguages: normalizeStringArray(body && body.subtitleLanguages),
    },
  };
}

async function createApp() {
  if (config.env !== "test") {
    await ensureMediaRuntime(config);
  }

  const app = express();
  const outputStore = createOutputStore(config, logger);
  const handlers = createQueueHandlers(outputStore, config, logger);
  const janitor = startStorageJanitor(config, logger);
  const cleanupTimer = setInterval(async () => {
    try {
      const deleted = await outputStore.cleanupExpired();
      if (deleted > 0) {
        logger.info({ deleted }, "Expired outputs cleaned up");
      }
    } catch (err) {
      logger.warn({ err }, "Output cleanup failed");
    }
  }, Math.max(30 * 1000, config.jobCleanupMs));
  if (cleanupTimer.unref) {
    cleanupTimer.unref();
  }

  const pdfJobs = await createJobManager({
    ttlMs: config.jobTtlMs,
    cleanupMs: config.jobCleanupMs,
    concurrency: Math.max(1, config.pdfJobConcurrency),
    logger,
    handlers,
    redisUrl: config.redisUrl,
    queueName: config.pdfQueueName,
    redisConnectTimeoutMs: config.redisConnectTimeoutMs,
    redisWorkerEnabled: config.runQueueWorkerInApi,
    allowInMemoryQueueFallback: config.allowInMemoryQueueFallback,
  });
  const mediaJobs = await createJobManager({
    ttlMs: config.jobTtlMs,
    cleanupMs: config.jobCleanupMs,
    concurrency: Math.max(1, config.mediaJobConcurrency),
    logger,
    handlers,
    redisUrl: config.redisUrl,
    queueName: config.mediaQueueName,
    redisConnectTimeoutMs: config.redisConnectTimeoutMs,
    redisWorkerEnabled: config.runQueueWorkerInApi,
    allowInMemoryQueueFallback: config.allowInMemoryQueueFallback,
  });

  function managerForType(type) {
    return MEDIA_JOB_TYPES.has(type) ? mediaJobs : pdfJobs;
  }

  async function getJobStats() {
    const [pdfStats, mediaStats] = await Promise.all([pdfJobs.stats(), mediaJobs.stats()]);
    return mergeStats(pdfStats, mediaStats);
  }

  async function assertQueueCapacity(kind, res) {
    const manager = kind === "media" ? mediaJobs : pdfJobs;
    const maxPending = kind === "media" ? config.mediaQueueMaxPending : config.pdfQueueMaxPending;
    const stats = await manager.stats();
    const pending = (stats.queued || 0) + (stats.running || 0);

    if (!isQueueOverloaded(stats, maxPending)) {
      return true;
    }

    res.status(429).json({
      ok: false,
      error: "Queue is saturated. Please retry shortly.",
      queue: kind,
      pending,
      maxPending,
    });
    return false;
  }

  async function findJobById(jobId) {
    const [pdfJob, mediaJob] = await Promise.all([pdfJobs.getJob(jobId), mediaJobs.getJob(jobId)]);
    return pdfJob || mediaJob || null;
  }

  async function findJobViewById(jobId) {
    const [pdfJob, mediaJob] = await Promise.all([pdfJobs.getJobView(jobId), mediaJobs.getJobView(jobId)]);
    return pdfJob || mediaJob || null;
  }

  async function findJobProgressById(jobId) {
    const [pdfProgress, mediaProgress] = await Promise.all([
      Promise.resolve(typeof pdfJobs.getJobProgress === "function" ? pdfJobs.getJobProgress(jobId) : null),
      Promise.resolve(typeof mediaJobs.getJobProgress === "function" ? mediaJobs.getJobProgress(jobId) : null),
    ]);
    return pdfProgress || mediaProgress || null;
  }
  const requireApiKey = apiKeyMiddleware();

  app.set("trust proxy", config.trustProxy);
  app.disable("x-powered-by");

  app.use(helmetMiddleware);
  app.use(corsMiddleware());
  app.use(pinoMiddleware);
  app.use(requestIdMiddleware);
  app.use(rateLimiter());
  app.use(express.json({ limit: "200kb" }));

  app.get("/api/v1/info/status", async (req, res, next) => {
    try {
      res.json({
        ok: true,
        status: "UP",
        service: "toolspage-api",
        uptimeSec: Math.round(process.uptime()),
        jobs: await getJobStats(),
        ts: new Date().toISOString(),
      });
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/v1/metrics", async (req, res, next) => {
    try {
      const jobStats = await getJobStats();
      const lines = [
        "# HELP toolspage_uptime_seconds Process uptime in seconds",
        "# TYPE toolspage_uptime_seconds gauge",
        `toolspage_uptime_seconds ${Math.round(process.uptime())}`,
        "# HELP toolspage_jobs_total Total jobs currently tracked in queue backend",
        "# TYPE toolspage_jobs_total gauge",
        `toolspage_jobs_total ${jobStats.total}`,
        "# HELP toolspage_jobs_queued Queued jobs",
        "# TYPE toolspage_jobs_queued gauge",
        `toolspage_jobs_queued ${jobStats.queued}`,
        "# HELP toolspage_jobs_running Running jobs",
        "# TYPE toolspage_jobs_running gauge",
        `toolspage_jobs_running ${jobStats.running}`,
        "# HELP toolspage_jobs_failed Failed jobs",
        "# TYPE toolspage_jobs_failed gauge",
        `toolspage_jobs_failed ${jobStats.failed}`,
        "# HELP toolspage_jobs_succeeded Succeeded jobs",
        "# TYPE toolspage_jobs_succeeded gauge",
        `toolspage_jobs_succeeded ${jobStats.succeeded}`,
        "# HELP toolspage_jobs_backend Queue backend selector (memory=0, redis=1)",
        "# TYPE toolspage_jobs_backend gauge",
        `toolspage_jobs_backend ${jobStats.backend === "redis" ? 1 : 0}`,
      ];

      res.setHeader("content-type", "text/plain; version=0.0.4");
      res.send(lines.join("\n") + "\n");
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/v1/config", async (req, res, next) => {
  try {
    const jobStats = await getJobStats();
    const authorized = isApiKeyAuthorized(req);
    const baseConfig = {
      ok: true,
      uploadLimitMb: config.uploadLimitMb,
      asyncThresholdMb: config.asyncThresholdMb,
      apiKeyRequired: Boolean(config.apiKey),
      media: {
        uploadLimitMb: config.mediaUploadLimitMb,
        rightsConfirmationRequired: config.mediaRequireRightsConfirmation,
        audioOutputFormats: config.mediaAudioOutputFormats,
        urlIngestEnabled: config.mediaUrlIngestEnabled,
      },
    };
    if (!authorized) {
      res.json(baseConfig);
      return;
    }

    res.json({
    ...baseConfig,
    rateLimit: {
      maxRequests: config.rateLimitMax,
      windowMs: config.rateLimitWindowMs,
    },
    queueBackend: jobStats.backend,
    queueNames: {
      pdf: config.pdfQueueName,
      media: config.mediaQueueName,
    },
    queueConcurrency: {
      pdf: config.pdfJobConcurrency,
      media: config.mediaJobConcurrency,
    },
    queueBackpressure: {
      pdfMaxPending: config.pdfQueueMaxPending,
      mediaMaxPending: config.mediaQueueMaxPending,
    },
    queueWorkerInApi: config.runQueueWorkerInApi,
    storageProvider: outputStore.provider,
    distributedRateLimit: config.distributedRateLimit,
    ocrProvider: config.ocrProvider,
    compressEngine: config.compressEngine,
    malwareScanEnabled: config.enableClamScan,
    media: {
      ...baseConfig.media,
      ffmpegRequired: config.ffmpegRequired,
      ffmpegTimeoutMs: config.ffmpegTimeoutMs,
      maxDurationSec: config.mediaMaxDurationSec,
      playlistMaxItems: config.ytdlpPlaylistMaxItems,
    },
    });
  } catch (err) {
    next(err);
  }
  });

  app.post("/api/v1/tools/pdf-to-word", requireApiKey, upload.single("file"), async (req, res, next) => {
  try {
    const { buffer, outputName } = await convertPdfToDocx(req.file, {
      language: req.body.language,
      ocrMode: req.body.ocrMode,
    }, config);

    res.setHeader("content-type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    res.setHeader("content-disposition", `attachment; filename="${outputName}"`);
    res.send(buffer);
  } catch (err) {
    next(err);
  }
  });

  app.post("/api/v1/tools/compress-pdf", requireApiKey, upload.single("file"), async (req, res, next) => {
  try {
    const { buffer, outputName, stats } = await compressPdf(req.file, {
      preset: req.body.preset,
      quality: req.body.quality,
    }, config);

    res.setHeader("content-type", "application/pdf");
    res.setHeader("content-disposition", `attachment; filename="${outputName}"`);
    res.setHeader("x-compression-ratio", String(stats.ratio));
    res.setHeader("x-compression-method", stats.method);
    res.send(buffer);
  } catch (err) {
    next(err);
  }
  });

  app.post("/api/v1/jobs/pdf-to-word", requireApiKey, upload.single("file"), async (req, res, next) => {
  try {
    if (!(await assertQueueCapacity("pdf", res))) {
      return;
    }

    const file = req.file;
    const payload = {
      language: req.body.language,
      ocrMode: req.body.ocrMode,
    };

    const job = managerForType("pdf-to-word").createJob({
      type: "pdf-to-word",
      meta: { inputName: file ? file.originalname : "unknown" },
      payload: buildQueuedFilePayload(file, payload),
    });

    res.status(202).json({ ok: true, job: await job });
  } catch (err) {
    next(err);
  }
  });

  app.post("/api/v1/jobs/compress-pdf", requireApiKey, upload.single("file"), async (req, res, next) => {
  try {
    if (!(await assertQueueCapacity("pdf", res))) {
      return;
    }

    const file = req.file;
    const payload = {
      preset: req.body.preset,
      quality: req.body.quality,
    };

    const job = managerForType("compress-pdf").createJob({
      type: "compress-pdf",
      meta: { inputName: file ? file.originalname : "unknown" },
      payload: buildQueuedFilePayload(file, payload),
    });

    res.status(202).json({ ok: true, job: await job });
  } catch (err) {
    next(err);
  }
  });

  app.post("/api/v1/tools/video-compress", requireApiKey, uploadMedia.single("file"), async (req, res, next) => {
  try {
    const { buffer, outputName, contentType, stats } = await compressVideo(req.file, {
      rightsConfirmed: req.body.rightsConfirmed,
      quality: req.body.quality,
      bitrateKbps: req.body.bitrateKbps,
    }, config, { signal: buildAbortSignal(req, res) });

    res.setHeader("content-type", contentType);
    res.setHeader("content-disposition", `attachment; filename="${outputName}"`);
    if (stats && Number.isFinite(stats.ratio)) {
      res.setHeader("x-compression-ratio", String(stats.ratio));
    }
    res.send(buffer);
  } catch (err) {
    next(err);
  }
  });

  app.post("/api/v1/tools/video-to-mp3", requireApiKey, uploadMedia.single("file"), async (req, res, next) => {
  try {
    const { buffer, outputName, contentType } = await videoToMp3(req.file, {
      rightsConfirmed: req.body.rightsConfirmed,
      bitrateKbps: req.body.bitrateKbps,
      metaTitle: req.body.metaTitle,
      metaArtist: req.body.metaArtist,
    }, config, { signal: buildAbortSignal(req, res) });

    res.setHeader("content-type", contentType);
    res.setHeader("content-disposition", `attachment; filename="${outputName}"`);
    res.send(buffer);
  } catch (err) {
    next(err);
  }
  });

  app.post("/api/v1/tools/audio-convert", requireApiKey, uploadMedia.single("file"), async (req, res, next) => {
  try {
    const { buffer, outputName, contentType } = await convertAudio(req.file, {
      rightsConfirmed: req.body.rightsConfirmed,
      targetFormat: req.body.targetFormat,
      bitrateKbps: req.body.bitrateKbps,
      metaTitle: req.body.metaTitle,
      metaArtist: req.body.metaArtist,
    }, config, { signal: buildAbortSignal(req, res) });

    res.setHeader("content-type", contentType);
    res.setHeader("content-disposition", `attachment; filename="${outputName}"`);
    res.send(buffer);
  } catch (err) {
    next(err);
  }
  });

  app.post("/api/v1/jobs/video-compress", requireApiKey, uploadMedia.single("file"), async (req, res, next) => {
  try {
    if (!(await assertQueueCapacity("media", res))) {
      return;
    }

    const file = req.file;
    const payload = {
      rightsConfirmed: req.body.rightsConfirmed,
      quality: req.body.quality,
      bitrateKbps: req.body.bitrateKbps,
    };

    const job = managerForType("video-compress").createJob({
      type: "video-compress",
      meta: { inputName: file ? file.originalname : "unknown" },
      payload: buildQueuedFilePayload(file, payload),
    });

    res.status(202).json({ ok: true, job: await job });
  } catch (err) {
    next(err);
  }
  });

  app.post("/api/v1/jobs/video-to-mp3", requireApiKey, uploadMedia.single("file"), async (req, res, next) => {
  try {
    if (!(await assertQueueCapacity("media", res))) {
      return;
    }

    const file = req.file;
    const payload = {
      rightsConfirmed: req.body.rightsConfirmed,
      bitrateKbps: req.body.bitrateKbps,
      metaTitle: req.body.metaTitle,
      metaArtist: req.body.metaArtist,
    };

    const job = managerForType("video-to-mp3").createJob({
      type: "video-to-mp3",
      meta: { inputName: file ? file.originalname : "unknown" },
      payload: buildQueuedFilePayload(file, payload),
    });

    res.status(202).json({ ok: true, job: await job });
  } catch (err) {
    next(err);
  }
  });

  app.post("/api/v1/jobs/audio-convert", requireApiKey, uploadMedia.single("file"), async (req, res, next) => {
  try {
    if (!(await assertQueueCapacity("media", res))) {
      return;
    }

    const file = req.file;
    const payload = {
      rightsConfirmed: req.body.rightsConfirmed,
      targetFormat: req.body.targetFormat,
      bitrateKbps: req.body.bitrateKbps,
      metaTitle: req.body.metaTitle,
      metaArtist: req.body.metaArtist,
    };

    const job = managerForType("audio-convert").createJob({
      type: "audio-convert",
      meta: { inputName: file ? file.originalname : "unknown" },
      payload: buildQueuedFilePayload(file, payload),
    });

    res.status(202).json({ ok: true, job: await job });
  } catch (err) {
    next(err);
  }
  });

  app.post("/api/v1/jobs/video-to-mp3-url", requireApiKey, async (req, res, next) => {
  try {
    if (!config.mediaUrlIngestEnabled) {
      res.status(403).json({ ok: false, error: "URL ingestion is disabled" });
      return;
    }

    if (!(await assertQueueCapacity("media", res))) {
      return;
    }

    const payload = {
      sourceUrl: req.body.sourceUrl,
      options: {
        rightsConfirmed: req.body.rightsConfirmed,
        bitrateKbps: req.body.bitrateKbps,
        quality: req.body.quality,
      },
    };

    const job = managerForType("video-to-mp3-url").createJob({
      type: "video-to-mp3-url",
      meta: { inputName: payload.sourceUrl || "url-source" },
      payload,
    });

    res.status(202).json({ ok: true, job: await job });
  } catch (err) {
    next(err);
  }
  });

  app.post("/api/v1/jobs/video-download-inspect", requireApiKey, async (req, res, next) => {
    try {
      if (!config.mediaUrlIngestEnabled) {
        res.status(403).json({ ok: false, error: "URL ingestion is disabled" });
        return;
      }

      const payload = normalizeDownloaderRequest(req.body, config, { inspectOnly: true });
      payload.options.mode = "metadata";

      const result = await downloadMediaFromUrl(payload, config, { signal: buildAbortSignal(req, res), logger });

      const metadata = JSON.parse(result.buffer.toString("utf8"));
      res.json({
        ok: true,
        metadata,
        inspect: {
          version: "v2",
          inspectedAt: new Date().toISOString(),
          platform: metadata.extractor || null,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/v1/jobs/image-inspect", requireApiKey, async (req, res, next) => {
    try {
      if (!config.mediaUrlIngestEnabled) {
        res.status(403).json({ ok: false, error: "URL ingestion is disabled" });
        return;
      }

      const result = await inspectImageFromUrl({
        sourceUrl: req.body && req.body.sourceUrl,
        options: {
          rightsConfirmed: req.body && req.body.rightsConfirmed,
        },
      }, config, { signal: buildAbortSignal(req, res), logger });

      res.json({
        ok: true,
        metadata: result,
        inspect: {
          version: "img-v1",
          inspectedAt: new Date().toISOString(),
          platform: result.extractor || null,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/v1/jobs/video-download-url", requireApiKey, async (req, res, next) => {
    try {
      if (!config.mediaUrlIngestEnabled) {
        res.status(403).json({ ok: false, error: "URL ingestion is disabled" });
        return;
      }

      if (!(await assertQueueCapacity("media", res))) {
        return;
      }

      const payload = normalizeDownloaderRequest(req.body, config);
      const mode = payload.options.mode;

      const job = managerForType("video-download-url").createJob({
        type: "video-download-url",
        meta: { inputName: payload.sourceUrl || "url-source", mode },
        payload,
      });

      res.status(202).json({ ok: true, job: await job });
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/v1/jobs/:jobId/progress", requireApiKey, async (req, res, next) => {
    try {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      if (res.flushHeaders) {
        res.flushHeaders();
      }

      let lastProgressSignature = null;
      const timer = setInterval(async () => {
        try {
          const job = await findJobViewById(req.params.jobId);
          if (!job) {
            res.write(`event: error\ndata: ${JSON.stringify({ error: "Job not found" })}\n\n`);
            clearInterval(timer);
            res.end();
            return;
          }

          const progressSnapshot = await findJobProgressById(req.params.jobId);
          // Use real progress snapshot if available; otherwise use conservative state fallback.
          let payload = progressSnapshot;
          if (!payload) {
            if (job.status === "queued") {
              payload = {
                jobId: job.id,
                status: job.status,
                stage: "queued",
                progress: 0,
                ts: new Date().toISOString(),
              };
            } else if (job.status === "running") {
              payload = {
                jobId: job.id,
                status: job.status,
                stage: "processing",
                progress: 15,
                ts: new Date().toISOString(),
              };
            } else {
              payload = {
                jobId: job.id,
                status: job.status,
                stage: "completed",
                progress: 100,
                downloadPercent: 100,
                ts: new Date().toISOString(),
              };
            }
          }

          const signature = `${payload.status}:${payload.stage}:${payload.progress}:${payload.ts}`;
          if (signature !== lastProgressSignature) {
            res.write(`event: status\ndata: ${JSON.stringify(payload)}\n\n`);
            lastProgressSignature = signature;
          }

          if (job.status === "succeeded" || job.status === "failed") {
            res.write(`event: complete\ndata: ${JSON.stringify({ status: job.status, jobId: job.id, error: job.error || null })}\n\n`);
            clearInterval(timer);
            res.end();
          }
        } catch (err) {
          res.write(`event: error\ndata: ${JSON.stringify({ error: err.message })}\n\n`);
          clearInterval(timer);
          res.end();
        }
      }, 500);

      req.on("close", () => {
        clearInterval(timer);
      });
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/v1/jobs/:jobId", requireApiKey, async (req, res, next) => {
    try {
      const job = await findJobViewById(req.params.jobId);
      if (!job) {
        res.status(404).json({ ok: false, error: "Job not found" });
        return;
      }

      if (job.downloadReady) {
        const raw = await findJobById(req.params.jobId);
        job.downloadPath = `/api/v1/jobs/${encodeURIComponent(req.params.jobId)}/download`;
        if (raw && raw.payload && raw.payload.options) {
          job.selectedQualityProfile = raw.payload.options.quality || null;
        }
        if (raw && raw.result && raw.result.stats) {
          job.resolvedQualityProfile = raw.result.stats.quality || null;
        }
        if (raw && raw.result && raw.result.storageKey) {
          job.downloadUrl = await outputStore.getDownloadUrl(raw.result.storageKey);
          job.storageKeyPresent = true;
        }
      }

      const progressSnapshot = await findJobProgressById(req.params.jobId);
      if (progressSnapshot) {
        job.progress = progressSnapshot;
      }

      res.json({ ok: true, job });
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/v1/jobs/:jobId/download", requireApiKey, async (req, res, next) => {
    try {
      const job = await findJobById(req.params.jobId);
      if (!job) {
        res.status(404).json({ ok: false, error: "Job not found" });
        return;
      }

      if (job.status !== "succeeded" || !job.result) {
        res.status(409).json({ ok: false, error: "Job is not ready for download" });
        return;
      }

      const contentType = job.result.contentType || "application/octet-stream";
      const outputName = job.result.outputName || "result.bin";
      let buffer = null;

      if (job.result.storageKey) {
        buffer = await outputStore.load(job.result.storageKey);
      } else {
        buffer = job.result.buffer
          ? job.result.buffer
          : Buffer.from(job.result.bufferBase64 || "", "base64");
      }

      res.setHeader("content-type", contentType);
      res.setHeader("content-disposition", `attachment; filename="${outputName}"`);

      if (job.result.stats && Number.isFinite(job.result.stats.ratio)) {
        res.setHeader("x-compression-ratio", String(job.result.stats.ratio));
      }

      res.send(buffer);
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/v1/outputs/*", async (req, res, next) => {
    try {
      const storageKey = req.params[0];
      const allowedByApiKey = isApiKeyAuthorized(req);
      const allowedBySignedUrl = outputStore.verifySignedDownload
        ? outputStore.verifySignedDownload(storageKey, req.query)
        : false;
      if (!allowedByApiKey && !allowedBySignedUrl) {
        res.status(401).json({ ok: false, error: "Unauthorized" });
        return;
      }
      const buffer = await outputStore.load(storageKey);
      res.setHeader("content-type", "application/octet-stream");
      res.send(buffer);
    } catch (err) {
      next(err);
    }
  });

  app.use(uploadErrorHandler);

  app.use(express.static(config.staticRoot, {
  index: ["index.html"],
  maxAge: config.env === "production" ? "1h" : 0,
  }));

  app.get("/status", (req, res) => {
    res.json({ status: "ok", version: "1.0.0", timestamp: new Date().toISOString() });
  });

  app.get("/api/v1/health/stats", async (req, res) => {
    try {
      // Use the 'pdf' manager as a representative for the backend stats
      const stats = await managerForType("pdf").stats();
      res.json({ ok: true, stats, timestamp: new Date().toISOString() });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get("/", (req, res) => {
    res.sendFile(path.join(config.staticRoot, "index.html"));
  });

  app.use("/api", notFoundHandler);
  app.use(errorHandler);

  return {
    app,
    shutdown: async () => {
      janitor.stop();
      clearInterval(cleanupTimer);
      await Promise.all([pdfJobs.stop(), mediaJobs.stop()]);
    },
  };
}

async function startServer() {
  const { app, shutdown } = await createApp();
  const server = app.listen(config.port, () => {
    logger.info({ port: config.port, env: config.env }, "Toolspage API started");
  });

  const stop = async () => {
    await shutdown();
    server.close(() => process.exit(0));
  };

  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

if (require.main === module) {
  startServer().catch((error) => {
    logger.error({ err: error }, "Failed to start Toolspage API");
    process.exit(1);
  });
}

module.exports = {
  createApp,
  startServer,
};
