const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

const { runCommand, scanFileBuffer } = require("./security");
const { VideoDownloadManager, URLValidator, DownloadError } = require("./video-download");

const VIDEO_MIME_PREFIXES = ["video/"];
const AUDIO_MIME_PREFIXES = ["audio/"];
const AUDIO_CONTENT_TYPE_BY_FORMAT = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  aac: "audio/aac",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
};

function spawnWithTimeout(command, args, timeoutMs, runtime) {
  return new Promise((resolve, reject) => {
    if (runtime && runtime.signal && runtime.signal.aborted) {
      const err = new Error("Client disconnected");
      err.code = "EABORTED";
      reject(err);
      return;
    }

    const child = spawn(command, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    const timeout = timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          child.kill();
        }, timeoutMs)
      : null;
    const onAbort = () => {
      aborted = true;
      child.kill();
    };
    if (runtime && runtime.signal) {
      runtime.signal.addEventListener("abort", onAbort);
    }

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      const str = chunk.toString("utf8");
      stderr += str;
      if (runtime && runtime.job && runtime.durationSec) {
        const match = str.match(/(?:out_time|time)=(\d{2}):(\d{2}):(\d{2}\.\d{2,6})/);
        if (match) {
          const h = parseInt(match[1], 10);
          const m = parseInt(match[2], 10);
          const s = parseFloat(match[3]);
          const currentSec = h * 3600 + m * 60 + s;
          const percent = Math.min(99, Math.floor((currentSec / runtime.durationSec) * 100)); // cap at 99%, 100% means succeeded
          if (percent > 0) {
            const now = Date.now();
            if (!runtime.lastProgress || now - runtime.lastProgress > 250) {
              runtime.lastProgress = now;
              runtime.job.updateProgress(percent).catch(() => {});
            }
          }
        }
      }
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      if (runtime && runtime.signal) {
        runtime.signal.removeEventListener("abort", onAbort);
      }

      if (aborted) {
        const err = new Error("Client disconnected");
        err.code = "EABORTED";
        reject(err);
        return;
      }

      if (timedOut) {
        const err = new Error(`Command timed out after ${timeoutMs}ms`);
        err.code = "ETIMEDOUT";
        reject(err);
        return;
      }

      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(new Error(stderr || `${command} exited with ${code}`));
    });
  });
}

function parseBoolean(value) {
  return value === true || value === "true" || value === "1" || value === "yes" || value === "on";
}

function safeBaseName(fileName, fallback) {
  return path.basename(String(fileName || fallback), path.extname(String(fileName || fallback))).replace(/[^a-zA-Z0-9-_]+/g, "-");
}

function normalizeExtension(fileName) {
  return path.extname(String(fileName || "")).toLowerCase();
}

function assertRights(options, config) {
  if (!config.mediaRequireRightsConfirmation) {
    return;
  }

  const confirmed = parseBoolean(options && options.rightsConfirmed);
  if (!confirmed) {
    const err = new Error("You must confirm you own rights to process this media.");
    err.status = 400;
    throw err;
  }
}

function assertMediaFile(file, { allowedExtensions, mimePrefixes, typeLabel }) {
  if (!file) {
    const err = new Error("No file provided");
    err.status = 400;
    throw err;
  }

  const ext = normalizeExtension(file.originalname);
  const extAllowed = allowedExtensions.includes(ext);
  const mime = String(file.mimetype || "").toLowerCase();
  const mimeAllowed = mimePrefixes.some((prefix) => mime.startsWith(prefix));

  if (!extAllowed && !mimeAllowed) {
    const err = new Error(`Unsupported ${typeLabel} file type`);
    err.status = 415;
    throw err;
  }
}

function assertMediaSize(file, config) {
  const size = file && file.buffer ? file.buffer.length : 0;
  if (!size || size <= config.mediaUploadLimitBytes) {
    return;
  }

  const err = new Error(`Media file too large. Max ${config.mediaUploadLimitMb}MB.`);
  err.status = 413;
  throw err;
}

async function readDurationSeconds(inputPath, config, runtime) {
  const args = [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    inputPath,
  ];

  let stdout = "";
  try {
    const result = await spawnWithTimeout(
      config.ffprobeCommand,
      args,
      Math.max(1000, config.ffprobeTimeoutMs),
      runtime,
    );
    stdout = result.stdout;
  } catch (error) {
    if (error && error.code === "EABORTED") {
      const abortedErr = new Error("Processing cancelled because the client disconnected.");
      abortedErr.status = 499;
      throw abortedErr;
    }

    if (error && error.code === "ETIMEDOUT") {
      const timeoutErr = new Error("Media metadata probe timed out.");
      timeoutErr.status = 408;
      throw timeoutErr;
    }

    throw error;
  }
  const output = stdout.trim();

  const duration = Number.parseFloat(output);
  if (!Number.isFinite(duration) || duration <= 0) {
    const err = new Error("Could not read media duration");
    err.status = 422;
    throw err;
  }
  return duration;
}

function getVideoCompressionParams(options) {
  const quality = String((options && options.quality) || "balanced").toLowerCase();
  if (quality === "high") {
    return { crf: "23", preset: "slow" };
  }
  if (quality === "small") {
    return { crf: "30", preset: "fast" };
  }
  return { crf: "27", preset: "medium" };
}

function getAudioBitrate(options, fallbackKbps) {
  const parsed = Number.parseInt((options && options.bitrateKbps) || "", 10);
  if (Number.isFinite(parsed) && parsed >= 64 && parsed <= 320) {
    return `${parsed}k`;
  }
  return `${fallbackKbps}k`;
}

async function runFfmpeg(args, config, runtime) {
  try {
    await spawnWithTimeout(
      config.ffmpegCommand,
      ["-hide_banner", "-loglevel", "error", "-stats", "-nostdin", "-y", ...args],
      Math.max(5000, config.ffmpegTimeoutMs),
      runtime,
    );
  } catch (error) {
    if (error && error.code === "EABORTED") {
      const abortedErr = new Error("Processing cancelled because the client disconnected.");
      abortedErr.status = 499;
      throw abortedErr;
    }

    if (error && error.code === "ETIMEDOUT") {
      const timeoutErr = new Error("Media processing timed out. Try a shorter file or lower quality profile.");
      timeoutErr.status = 408;
      throw timeoutErr;
    }

    const err = new Error("Media processing failed. Verify input file and codec support.");
    err.status = 422;
    throw err;
  }
}

module.exports.runFfmpeg = runFfmpeg;

async function withTempWorkingFiles(sourceBuffer, sourceSuffix, outputSuffix, action) {
  const workingDir = await fs.mkdtemp(path.join(os.tmpdir(), "toolspage-media-"));
  const inputPath = path.join(workingDir, `input-${crypto.randomUUID()}${sourceSuffix}`);
  const outputPath = path.join(workingDir, `output-${crypto.randomUUID()}${outputSuffix}`);
  await fs.writeFile(inputPath, sourceBuffer);

  try {
    return await action(inputPath, outputPath);
  } finally {
    await fs.rm(workingDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function enforceDurationLimit(inputPath, config, runtime) {
  const durationSec = await readDurationSeconds(inputPath, config, runtime);
  if (runtime) {
    runtime.durationSec = durationSec;
  }
  if (durationSec > config.mediaMaxDurationSec) {
    const err = new Error(`Media is too long. Max duration is ${config.mediaMaxDurationSec} seconds.`);
    err.status = 422;
    throw err;
  }
  return durationSec;
}

async function compressVideo(file, options, config, runtime) {
  assertRights(options, config);
  assertMediaSize(file, config);
  assertMediaFile(file, {
    allowedExtensions: config.mediaVideoExtensions,
    mimePrefixes: VIDEO_MIME_PREFIXES,
    typeLabel: "video",
  });
  await scanFileBuffer(file.buffer, config || {});

  const inputExt = normalizeExtension(file.originalname) || ".mp4";
  const outputExt = ".mp4";
  const { crf, preset } = getVideoCompressionParams(options);
  const audioBitrate = getAudioBitrate(options, 128);

  return withTempWorkingFiles(file.buffer, inputExt, outputExt, async (inputPath, outputPath) => {
    const durationSec = await enforceDurationLimit(inputPath, config, runtime);
    await runFfmpeg([
      "-i",
      inputPath,
      "-c:v",
      "libx264",
      "-preset",
      preset,
      "-crf",
      crf,
      "-c:a",
      "aac",
      "-b:a",
      audioBitrate,
      outputPath,
    ], config, runtime);

    const buffer = await fs.readFile(outputPath);
    const ratio = Number((buffer.length / file.buffer.length).toFixed(3));
    return {
      buffer,
      outputName: `${safeBaseName(file.originalname, "video")}-compressed.mp4`,
      contentType: "video/mp4",
      stats: {
        inputBytes: file.buffer.length,
        outputBytes: buffer.length,
        ratio,
        method: "ffmpeg-libx264",
        durationSec: Number(durationSec.toFixed(2)),
      },
    };
  });
}

async function videoToMp3(file, options, config, runtime) {
  assertRights(options, config);
  assertMediaSize(file, config);
  assertMediaFile(file, {
    allowedExtensions: config.mediaVideoExtensions,
    mimePrefixes: VIDEO_MIME_PREFIXES,
    typeLabel: "video",
  });
  await scanFileBuffer(file.buffer, config || {});

  const inputExt = normalizeExtension(file.originalname) || ".mp4";
  const outputExt = ".mp3";
  const audioBitrate = getAudioBitrate(options, 192);

  return withTempWorkingFiles(file.buffer, inputExt, outputExt, async (inputPath, outputPath) => {
    const durationSec = await enforceDurationLimit(inputPath, config, runtime);
    const ffmpegArgs = [
      "-i", inputPath,
      "-vn",
      "-c:a", "libmp3lame",
      "-b:a", audioBitrate
    ];
    if (options && options.metaTitle) {
      ffmpegArgs.push("-metadata", `title=${options.metaTitle}`);
    }
    if (options && options.metaArtist) {
      ffmpegArgs.push("-metadata", `artist=${options.metaArtist}`);
    }
    ffmpegArgs.push(outputPath);

    await runFfmpeg(ffmpegArgs, config, runtime);

    const buffer = await fs.readFile(outputPath);
    return {
      buffer,
      outputName: `${safeBaseName(file.originalname, "audio")}.mp3`,
      contentType: "audio/mpeg",
      stats: {
        outputBytes: buffer.length,
        method: "ffmpeg-mp3-extract",
        durationSec: Number(durationSec.toFixed(2)),
      },
    };
  });
}

function assertAudioFormat(format, config) {
  const normalized = String(format || "mp3").toLowerCase();
  if (!config.mediaAudioOutputFormats.includes(normalized)) {
    const err = new Error(`Unsupported output format: ${normalized}`);
    err.status = 400;
    throw err;
  }
  return normalized;
}

function buildAudioCodecArgs(targetFormat, options) {
  const bitrate = getAudioBitrate(options, 192);
  if (targetFormat === "mp3") {
    return ["-c:a", "libmp3lame", "-b:a", bitrate];
  }
  if (targetFormat === "wav") {
    return ["-c:a", "pcm_s16le", "-ar", "44100"];
  }
  if (targetFormat === "aac" || targetFormat === "m4a") {
    return ["-c:a", "aac", "-b:a", bitrate];
  }
  if (targetFormat === "ogg") {
    return ["-c:a", "libvorbis", "-q:a", "6"];
  }
  return ["-c:a", "libmp3lame", "-b:a", bitrate];
}

function normalizeAllowlistEntry(value) {
  const entry = String(value || "").trim().toLowerCase();
  if (!entry) {
    return "";
  }
  if (entry.startsWith("*.")) {
    return entry.slice(2);
  }
  return entry;
}

function isAllowlistedSource(hostname, platform, allowlist) {
  if (!Array.isArray(allowlist) || allowlist.length === 0) {
    return true;
  }

  const normalizedHost = String(hostname || "").toLowerCase();
  const normalizedPlatform = String(platform || "").toLowerCase();

  return allowlist.some((rawEntry) => {
    const entry = normalizeAllowlistEntry(rawEntry);
    if (!entry) {
      return false;
    }

    if (entry === normalizedPlatform) {
      return true;
    }

    return normalizedHost === entry || normalizedHost.endsWith(`.${entry}`);
  });
}

function assertVideoDownloadFormat(format) {
  const normalized = String(format || "mp4").toLowerCase();
  const allowed = new Set(["mp4", "webm", "mkv"]);
  if (!allowed.has(normalized)) {
    const err = new Error(`Unsupported video format: ${normalized}`);
    err.status = 400;
    throw err;
  }
  return normalized;
}

function assertSubtitleFormat(format) {
  const normalized = String(format || "vtt").toLowerCase();
  const allowed = new Set(["vtt", "srt"]);
  if (!allowed.has(normalized)) {
    const err = new Error(`Unsupported subtitle format: ${normalized}`);
    err.status = 400;
    throw err;
  }
  return normalized;
}

function extractImageUrlsFromHtml(html, baseUrl) {
  const text = String(html || "");
  const found = [];

  const metaPatterns = [
    /<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image)["'][^>]+content=["']([^"']+)["'][^>]*>/gi,
    /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:image|twitter:image)["'][^>]*>/gi,
  ];

  for (const pattern of metaPatterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      if (match[1]) {
        found.push(match[1]);
      }
    }
  }

  // Pinterest pages frequently contain high-resolution pinimg URLs in JSON blobs.
  const pinimgPattern = /https?:\/\/i\.pinimg\.com\/[^"'\s<>]+/gi;
  let pinimgMatch;
  while ((pinimgMatch = pinimgPattern.exec(text)) !== null) {
    if (pinimgMatch[0]) {
      found.push(pinimgMatch[0]);
    }
  }

  const unique = new Set();
  const urls = [];
  for (const candidate of found) {
    try {
      const normalized = new URL(candidate, baseUrl).toString();
      if (!/^https?:\/\//i.test(normalized)) {
        continue;
      }
      if (!unique.has(normalized)) {
        unique.add(normalized);
        urls.push(normalized);
      }
    } catch (_err) {
      // Ignore malformed values.
    }
  }

  return urls;
}

async function inspectImageFromUrl(payload, config, runtime = {}) {
  if (!config.mediaUrlIngestEnabled) {
    const err = new Error("URL ingestion is disabled");
    err.status = 403;
    throw err;
  }

  const options = (payload && payload.options) || {};
  assertRights(options, config);

  const sourceUrl = payload && payload.sourceUrl;
  if (!sourceUrl) {
    const err = new Error("Source URL required");
    err.status = 400;
    throw err;
  }

  let validatedUrl;
  try {
    validatedUrl = await URLValidator.validateUrlResolved(sourceUrl);
  } catch (err) {
    err.status = err.status || 400;
    throw err;
  }

  const platform = URLValidator.detectPlatform(sourceUrl);
  if (!isAllowlistedSource(validatedUrl.hostname, platform, config.mediaUrlAllowlist)) {
    const err = new Error("Source URL is not in the configured allowlist");
    err.status = 403;
    throw err;
  }

  if (runtime.signal?.aborted) {
    const abortErr = new Error("Inspection cancelled by client");
    abortErr.status = 499;
    throw abortErr;
  }

  const timeoutMs = Math.max(10000, Math.min(45000, Number(config.ytdlpTimeoutMs || 30000)));
  const timeoutController = new AbortController();
  const timeoutHandle = setTimeout(() => timeoutController.abort(), timeoutMs);
  const onClientAbort = () => timeoutController.abort();
  if (runtime.signal) {
    runtime.signal.addEventListener("abort", onClientAbort);
  }

  try {
    const response = await fetch(sourceUrl, {
      method: "GET",
      redirect: "follow",
      signal: timeoutController.signal,
      headers: {
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      },
    });

    const finalUrl = response && response.url ? String(response.url) : String(sourceUrl);
    const html = await response.text();
    const imageUrls = extractImageUrlsFromHtml(html, finalUrl);

    if (imageUrls.length === 0) {
      const err = new Error("No image metadata found at source URL");
      err.status = 422;
      throw err;
    }

    return {
      sourceUrl: finalUrl,
      webpageUrl: finalUrl,
      extractor: "opengraph",
      thumbnail: imageUrls[0],
      thumbnails: imageUrls.slice(0, 30).map((url) => ({ url, width: null, height: null })),
      isPlaylist: false,
      entries: [],
    };
  } catch (err) {
    if (err && err.name === "AbortError") {
      const timeoutErr = new Error("Image inspection timed out");
      timeoutErr.status = runtime.signal?.aborted ? 499 : 408;
      throw timeoutErr;
    }
    throw err;
  } finally {
    clearTimeout(timeoutHandle);
    if (runtime.signal) {
      runtime.signal.removeEventListener("abort", onClientAbort);
    }
  }
}

async function convertAudio(file, options, config, runtime) {
  assertRights(options, config);
  assertMediaSize(file, config);
  assertMediaFile(file, {
    allowedExtensions: config.mediaAudioExtensions,
    mimePrefixes: AUDIO_MIME_PREFIXES,
    typeLabel: "audio",
  });
  await scanFileBuffer(file.buffer, config || {});

  const targetFormat = assertAudioFormat(options && options.targetFormat, config);
  const inputExt = normalizeExtension(file.originalname) || ".mp3";
  const outputExt = `.${targetFormat}`;

  return withTempWorkingFiles(file.buffer, inputExt, outputExt, async (inputPath, outputPath) => {
    const durationSec = await enforceDurationLimit(inputPath, config, runtime);
    const ffmpegArgs = [
      "-i", inputPath,
      ...buildAudioCodecArgs(targetFormat, options)
    ];
    if (options && options.metaTitle) {
      ffmpegArgs.push("-metadata", `title=${options.metaTitle}`);
    }
    if (options && options.metaArtist) {
      ffmpegArgs.push("-metadata", `artist=${options.metaArtist}`);
    }
    ffmpegArgs.push(outputPath);

    await runFfmpeg(ffmpegArgs, config, runtime);

    const buffer = await fs.readFile(outputPath);
    return {
      buffer,
      outputName: `${safeBaseName(file.originalname, "audio")}.${targetFormat}`,
      contentType: AUDIO_CONTENT_TYPE_BY_FORMAT[targetFormat] || "application/octet-stream",
      stats: {
        outputBytes: buffer.length,
        method: `ffmpeg-audio-${targetFormat}`,
        durationSec: Number(durationSec.toFixed(2)),
      },
    };
  });
}

async function videoToMp3FromUrl(payload, config, runtime) {
  if (!config.mediaUrlIngestEnabled) {
    const err = new Error("URL ingestion is disabled");
    err.status = 403;
    throw err;
  }

  const options = (payload && payload.options) || {};
  assertRights(options, config);
  
  const sourceUrl = payload && payload.sourceUrl;
  if (!sourceUrl) {
    const err = new Error("Source URL required");
    err.status = 400;
    throw err;
  }

  // Validate URL security (prevent SSRF)
  let validatedUrl;
  try {
    validatedUrl = await URLValidator.validateUrlResolved(sourceUrl);
  } catch (err) {
    err.status = err.status || 400;
    throw err;
  }

  // Detect platform for logging
  const platform = URLValidator.detectPlatform(sourceUrl);
  if (!isAllowlistedSource(validatedUrl.hostname, platform, config.mediaUrlAllowlist)) {
    const err = new Error("Source URL is not in the configured allowlist");
    err.status = 403;
    throw err;
  }

  const logger = runtime.logger || console;

  logger.info({ sourceUrl, platform }, "Starting video-to-mp3 URL download");

  // Use VideoDownloadManager for robust downloading
  const downloadManager = new VideoDownloadManager(config, logger);
  
  try {
    const quality = options.quality || config.ytdlpDefaultQuality || "medium";
    
    const result = await downloadManager.downloadWithRetry(
      sourceUrl,
      {
        outputFormat: "audio",
        quality,
      },
      runtime,
      3 // max retry attempts
    );

    logger.info(
      {
        sourceUrl,
        platform: result.stats.platform,
        sizeBytes: result.stats.outputBytes,
        quality: result.stats.quality,
      },
      "URL download completed successfully"
    );

    return result;
  } catch (err) {
    // Enhance error with context
    if (err instanceof DownloadError) {
      logger.error(
        {
          sourceUrl,
          platform,
          classification: err.classification,
          error: err.message,
        },
        "URL download failed with classified error"
      );
      throw err;
    }

    // Wrap unknown errors
    logger.error({ sourceUrl, platform, error: err.message }, "URL download failed");
    const wrappedErr = new Error(`Download failed: ${err.message}`);
    wrappedErr.status = 500;
    throw wrappedErr;
  }
}

async function downloadMediaFromUrl(payload, config, runtime) {
  if (!config.mediaUrlIngestEnabled) {
    const err = new Error("URL ingestion is disabled");
    err.status = 403;
    throw err;
  }

  const options = (payload && payload.options) || {};
  assertRights(options, config);

  const sourceUrl = payload && payload.sourceUrl;
  if (!sourceUrl) {
    const err = new Error("Source URL required");
    err.status = 400;
    throw err;
  }

  let validatedUrl;
  try {
    validatedUrl = await URLValidator.validateUrlResolved(sourceUrl);
  } catch (err) {
    err.status = err.status || 400;
    throw err;
  }

  const platform = URLValidator.detectPlatform(sourceUrl);
  if (!isAllowlistedSource(validatedUrl.hostname, platform, config.mediaUrlAllowlist)) {
    const err = new Error("Source URL is not in the configured allowlist");
    err.status = 403;
    throw err;
  }

  const logger = runtime.logger || console;
  const downloadManager = new VideoDownloadManager(config, logger);

  const mode = String(options.mode || "video").toLowerCase();
  const quality = String(options.quality || config.ytdlpDefaultQuality || "medium").toLowerCase();
  const allowPlaylist = parseBoolean(options.allowPlaylist);
  const playlistMaxItems = Number.parseInt(options.playlistMaxItems || "", 10);
  const playlistEnd = Number.isFinite(playlistMaxItems) && playlistMaxItems > 0
    ? playlistMaxItems
    : Math.max(1, Number.parseInt(config.ytdlpPlaylistMaxItems || "25", 10));

  logger.info({ sourceUrl, platform, mode, quality, allowPlaylist }, "Starting unified URL download");

  if (mode === "metadata") {
    const metadata = await downloadManager.inspectUrl(sourceUrl, {
      allowPlaylist,
      playlistEnd,
    }, runtime);

    const buffer = Buffer.from(JSON.stringify(metadata, null, 2), "utf8");
    return {
      buffer,
      outputName: `metadata-${safeBaseName(metadata.title || platform || "video", "video")}.json`,
      contentType: "application/json",
      stats: {
        outputBytes: buffer.length,
        method: "yt-dlp-metadata",
        platform,
      },
    };
  }

  if (mode !== "audio" && mode !== "video") {
    const err = new Error("Invalid mode. Supported: video, audio, metadata");
    err.status = 400;
    throw err;
  }

  const includeSubtitles = parseBoolean(options.includeSubtitles);
  const subtitleFormat = assertSubtitleFormat(options.subtitleFormat || "vtt");
  const subtitleLanguages = Array.isArray(options.subtitleLanguages)
    ? options.subtitleLanguages.map((item) => String(item).trim()).filter(Boolean)
    : [];

  const targetAudioFormat = mode === "audio"
    ? assertAudioFormat(options.audioFormat || "mp3", {
      mediaAudioOutputFormats: ["mp3", "m4a", "aac", "wav", "ogg"],
    })
    : null;
  const targetVideoFormat = mode === "video"
    ? assertVideoDownloadFormat(options.videoFormat || "mp4")
    : null;

  return downloadManager.downloadWithRetry(
    sourceUrl,
    {
      outputFormat: mode,
      quality,
      allowPlaylist,
      playlistEnd,
      targetAudioFormat,
      targetVideoFormat,
      includeSubtitles,
      subtitleLanguages,
      subtitleFormat,
    },
    runtime,
    3,
  );
}

async function ensureMediaRuntime(config) {
  if (!config.ffmpegRequired) {
    return;
  }

  const checks = [
    { command: config.ffmpegCommand, args: ["-version"], name: "ffmpeg" },
    { command: config.ffprobeCommand, args: ["-version"], name: "ffprobe" },
  ];

  for (const check of checks) {
    try {
      await runCommand(check.command, check.args);
    } catch (_error) {
      const err = new Error(`Required media runtime dependency is missing: ${check.name}`);
      err.status = 500;
      throw err;
    }
  }
}

module.exports = {
  compressVideo,
  videoToMp3,
  convertAudio,
  videoToMp3FromUrl,
  downloadMediaFromUrl,
  inspectImageFromUrl,
  ensureMediaRuntime,
  runFfmpeg,
  __internal: {
    spawnWithTimeout,
  },
};