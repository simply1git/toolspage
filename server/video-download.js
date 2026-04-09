const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const dns = require("node:dns/promises");
const net = require("node:net");
const YTDlpWrap = require("yt-dlp-wrap").default;
const JSZip = require("jszip");

/**
 * Platform detection and validation
 */
class URLValidator {
  static platformPatterns = {
    youtube: /(?:youtube\.com|youtu\.be|youtube-nocookie\.com)/i,
    vimeo: /vimeo\.com/i,
    dailymotion: /dailymotion\.com|dai\.ly/i,
    twitter: /(?:twitter|x)\.com/i,
    instagram: /instagram\.com/i,
    pinterest: /pinterest\.com|pin\.it/i,
    tiktok: /(?:tiktok\.com|vm\.tiktok|vt\.tiktok)/i,
    twitch: /twitch\.tv/i,
    reddit: /reddit\.com/i,
    facebook: /facebook\.com|fb\.watch/i,
    soundcloud: /soundcloud\.com/i,
  };

  static validateUrl(urlString) {
    try {
      const url = new URL(urlString);
      
      if (!["http:", "https:"].includes(url.protocol)) {
        const err = new Error("Invalid protocol. Only HTTP/HTTPS allowed");
        err.status = 400;
        throw err;
      }

      const hostname = url.hostname.toLowerCase();
      if (this.isInternalAddress(hostname)) {
        const err = new Error("Internal/private addresses blocked for security");
        err.status = 403;
        throw err;
      }

      return { valid: true, url, hostname };
    } catch (err) {
      if (!err.status) {
        err.status = 400;
      }
      throw err;
    }
  }

  static isInternalAddress(hostname) {
    const internalPatterns = [
      /^localhost$/i,
      /^127\./,
      /^10\./,
      /^172\.(1[6-9]|2[0-9]|3[01])\./,
      /^192\.168\./,
      /^::1$/,
      /^fc00:/,
      /\.local$/i,
    ];
    return internalPatterns.some((p) => p.test(hostname));
  }

  static detectPlatform(url) {
    for (const [platform, regex] of Object.entries(this.platformPatterns)) {
      if (regex.test(url)) {
        return platform;
      }
    }
    return "generic";
  }

  static isPrivateIpAddress(ip) {
    if (!ip || net.isIP(ip) === 0) {
      return true;
    }

    if (ip === "127.0.0.1" || ip === "::1") {
      return true;
    }

    if (ip.includes(":")) {
      const normalized = ip.toLowerCase();
      return normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe80:");
    }

    const parts = ip.split(".").map((part) => Number.parseInt(part, 10));
    if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part) || part < 0 || part > 255)) {
      return true;
    }
    if (parts[0] === 10) return true;
    if (parts[0] === 127) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    return false;
  }

  static async validateUrlResolved(urlString) {
    const validated = this.validateUrl(urlString);
    const records = await dns.lookup(validated.hostname, { all: true }).catch(() => []);
    if (!records.length) {
      const err = new Error("Unable to resolve source hostname");
      err.status = 400;
      throw err;
    }
    for (const record of records) {
      if (this.isPrivateIpAddress(record && record.address)) {
        const err = new Error("Source URL resolves to blocked internal address");
        err.status = 403;
        throw err;
      }
    }
    return validated;
  }
}

/**
 * Error classification for intelligent retry logic
 */
class DownloadError extends Error {
  constructor(message, classification = "Unknown", details = {}) {
    super(message);
    this.name = "DownloadError";
    this.classification = classification;
    this.details = details;
    
    const errorClasses = {
      AgeRestricted: { status: 403, retryable: false },
      Private: { status: 403, retryable: false },
      MemberOnly: { status: 403, retryable: false },
      GeoRestricted: { status: 451, retryable: false },
      Removed: { status: 410, retryable: false },
      NotFound: { status: 404, retryable: false },
      NetworkError: { status: 503, retryable: true, maxRetries: 3 },
      TimeoutError: { status: 408, retryable: true, maxRetries: 2 },
      RateLimited: { status: 429, retryable: true, maxRetries: 1 },
      NoFormatAvailable: { status: 422, retryable: false },
      FileSizeExceeded: { status: 413, retryable: false },
      UnsupportedPlatform: { status: 415, retryable: false },
    };

    const errorClass = errorClasses[classification] || { status: 500, retryable: false };
    this.status = errorClass.status;
    this.retryable = errorClass.retryable;
    this.maxRetries = errorClass.maxRetries || 0;
  }
}

function classifyYtdlpError(stderr) {
  const lower = stderr.toLowerCase();

  if (lower.includes("age") && lower.includes("restrict")) {
    return new DownloadError(
      "Video is age-restricted and cannot be downloaded without authentication",
      "AgeRestricted"
    );
  }

  if (lower.includes("private") || lower.includes("members-only")) {
    return new DownloadError(
      lower.includes("members") ? "Video is members-only" : "Video is private",
      lower.includes("members") ? "MemberOnly" : "Private"
    );
  }

  if (lower.includes("not available") && (lower.includes("country") || lower.includes("region"))) {
    return new DownloadError(
      "Video not available in your geographic region",
      "GeoRestricted"
    );
  }

  if (lower.includes("removed") || lower.includes("no longer available") || lower.includes("been deleted")) {
    return new DownloadError("Video has been removed or deleted", "Removed");
  }

  if (lower.includes("video not found") || lower.includes("404") || lower.includes("does not exist")) {
    return new DownloadError("Video not found", "NotFound");
  }

  if (lower.includes("no formats") || lower.includes("unable to extract") || lower.includes("unsupported url")) {
    return new DownloadError("No downloadable formats found for this video", "NoFormatAvailable");
  }

  if (lower.includes("file is larger") || lower.includes("exceeds")) {
    return new DownloadError("Video file size exceeds limit", "FileSizeExceeded");
  }

  if (lower.includes("429") || lower.includes("rate limit") || lower.includes("too many requests")) {
    return new DownloadError("Rate limited by platform. Try again later", "RateLimited");
  }

  if (lower.includes("timed out") || lower.includes("timeout")) {
    return new DownloadError("Download timed out", "TimeoutError");
  }

  if (lower.includes("network") || lower.includes("connection") || lower.includes("socket")) {
    return new DownloadError("Network connection error", "NetworkError");
  }

  return new DownloadError(`Download failed: ${stderr.substring(0, 200)}`, "Unknown");
}

function clampPercent(value) {
  const num = Number.parseFloat(value);
  if (!Number.isFinite(num)) {
    return null;
  }
  if (num < 0) return 0;
  if (num > 100) return 100;
  return num;
}

function parsePercentFromText(text) {
  const content = String(text || "");
  const match = content.match(/(\d{1,3}(?:\.\d+)?)%/);
  if (!match) {
    return null;
  }
  return clampPercent(match[1]);
}

function toFiniteNumber(value) {
  const num = Number.parseFloat(value);
  return Number.isFinite(num) ? num : null;
}

function classifyVideoProfile(height, fps) {
  if (!Number.isFinite(height)) {
    return null;
  }
  if (height >= 2160) {
    return Number.isFinite(fps) && fps >= 50 ? "4k60" : "4k";
  }
  if (height >= 1440) {
    return Number.isFinite(fps) && fps >= 50 ? "1440p60" : "1440p";
  }
  if (height >= 1080) {
    return Number.isFinite(fps) && fps >= 50 ? "1080p60" : "1080p";
  }
  if (height >= 720) {
    return Number.isFinite(fps) && fps >= 50 ? "720p60" : "720p";
  }
  if (height >= 480) {
    return "480p";
  }
  return null;
}

function profileLabel(profile) {
  const labels = {
    "4k60": "4K UHD 60fps",
    "4k": "4K UHD",
    "1440p60": "1440p 60fps",
    "1440p": "1440p",
    "1080p60": "1080p 60fps",
    "1080p": "1080p",
    "720p60": "720p 60fps",
    "720p": "720p",
    "480p": "480p",
    "audio-high": "Audio only (high)",
    "audio-medium": "Audio only (medium)",
    "audio-low": "Audio only (low)",
  };
  return labels[profile] || profile;
}

function profileRank(profile) {
  const ranks = {
    "4k60": 1,
    "4k": 2,
    "1440p60": 3,
    "1440p": 4,
    "1080p60": 5,
    "1080p": 6,
    "720p60": 7,
    "720p": 8,
    "480p": 9,
    "audio-high": 10,
    "audio-medium": 11,
    "audio-low": 12,
  };
  return ranks[profile] || 100;
}

async function isPlayableMediaFile(filePath, config, runtime) {
  if (String(process.env.NODE_ENV || "").toLowerCase() === "test") {
    return true;
  }
  const { __internal } = require("./media");
  const args = [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    filePath,
  ];
  try {
    const out = await __internal.spawnWithTimeout(
      config.ffprobeCommand || "ffprobe",
      args,
      Math.max(3000, Number(config.ffprobeTimeoutMs || 20000)),
      runtime,
    );
    const stderr = String(out && out.stderr ? out.stderr : "").trim();
    if (stderr.length > 0) {
      return false;
    }
    const duration = Number.parseFloat(String(out && out.stdout ? out.stdout : "").trim());
    return Number.isFinite(duration) && duration > 0;
  } catch (_err) {
    return false;
  }
}

function buildAvailableQualityProfiles(formats) {
  const allFormats = Array.isArray(formats) ? formats : [];
  const buckets = new Map();

  const ensureBucket = (profile) => {
    if (!profile) {
      return null;
    }
    if (!buckets.has(profile)) {
      buckets.set(profile, {
        profile,
        label: profileLabel(profile),
        rank: profileRank(profile),
        height: null,
        fps: null,
        formatCount: 0,
        hasMuxedAudio: false,
      });
    }
    return buckets.get(profile);
  };

  for (const format of allFormats) {
    const vcodec = String((format && format.vcodec) || "none").toLowerCase();
    const acodec = String((format && format.acodec) || "none").toLowerCase();
    const hasVideo = vcodec !== "none";
    const hasAudio = acodec !== "none";

    if (hasVideo) {
      const height = toFiniteNumber(format && format.height);
      const fps = toFiniteNumber(format && format.fps);
      const profile = classifyVideoProfile(height, fps);
      const bucket = ensureBucket(profile);
      if (!bucket) {
        continue;
      }
      bucket.formatCount += 1;
      if (Number.isFinite(height)) {
        bucket.height = Math.max(bucket.height || 0, height);
      }
      if (Number.isFinite(fps)) {
        bucket.fps = Math.max(bucket.fps || 0, fps);
      }
      if (hasAudio) {
        bucket.hasMuxedAudio = true;
      }
      continue;
    }

    if (hasAudio) {
      const abr = toFiniteNumber(format && format.abr);
      let profile = "audio-medium";
      if (Number.isFinite(abr) && abr >= 256) {
        profile = "audio-high";
      } else if (Number.isFinite(abr) && abr <= 128) {
        profile = "audio-low";
      }
      const bucket = ensureBucket(profile);
      if (bucket) {
        bucket.formatCount += 1;
      }
    }
  }

  if (buckets.size === 0) {
    return ["4k60", "4k", "1440p60", "1440p", "1080p60", "1080p", "720p60", "720p", "480p", "audio-high", "audio-medium", "audio-low"]
      .map((profile) => ({
        profile,
        label: profileLabel(profile),
        rank: profileRank(profile),
        source: "fallback",
      }));
  }

  return Array.from(buckets.values())
    .sort((a, b) => a.rank - b.rank)
    .map((item) => ({
      profile: item.profile,
      label: item.label,
      rank: item.rank,
      source: "inspect",
      height: item.height,
      fps: item.fps,
      formatCount: item.formatCount,
      hasMuxedAudio: item.hasMuxedAudio,
    }));
}

/**
 * State-of-the-art video download manager
 */
class VideoDownloadManager {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    
    const ytdlpBinary = process.env.YTDLP_BINARY || "yt-dlp";
    
    try {
      this.ytdlp = new YTDlpWrap(ytdlpBinary);
    } catch (err) {
      this.logger.warn({ error: err.message }, "yt-dlp binary not found, will try to download");
      this.ytdlp = new YTDlpWrap();
    }
  }

  async resolveCanonicalUrl(url, runtime = {}) {
    const source = String(url || "").trim();
    if (!source) {
      return source;
    }

    // Only normalize known short-link hosts where extractors are sensitive.
    const looksLikeShortLink = /(^https?:\/\/)?(www\.)?(pin\.it|t\.co|bit\.ly|tinyurl\.com)\//i.test(source);
    if (!looksLikeShortLink) {
      return source;
    }

    if (runtime.signal?.aborted) {
      const err = new Error("Request cancelled by client");
      err.status = 499;
      throw err;
    }

    const timeoutMs = Math.max(4000, Math.min(15000, Number(this.config.ytdlpTimeoutMs || 12000)));
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    if (runtime.signal) {
      runtime.signal.addEventListener("abort", onAbort);
    }

    try {
      const response = await fetch(source, {
        method: "GET",
        redirect: "follow",
        signal: controller.signal,
        headers: {
          "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        },
      });

      let resolved = response && response.url ? String(response.url) : source;

      // Some pin.it links return HTML with script-based redirects instead of HTTP 30x.
      if (/pin\.it\//i.test(source) && /pin\.it\//i.test(resolved)) {
        const html = await response.text().catch(() => "");

        const urlFromJson = /https?:\/\/(?:www\.)?pinterest\.com\/pin\/(\d{5,})\//i.exec(html || "");
        if (urlFromJson && urlFromJson[1]) {
          resolved = `https://www.pinterest.com/pin/${urlFromJson[1]}/`;
        } else {
          const pinIdFromJson = /"pin_id"\s*:\s*"?(\d{5,})"?|"id"\s*:\s*"?(\d{5,})"?/i.exec(html || "");
          const extractedId = pinIdFromJson ? (pinIdFromJson[1] || pinIdFromJson[2]) : null;
          if (extractedId) {
            resolved = `https://www.pinterest.com/pin/${extractedId}/`;
          }
        }
      }

      if (resolved && resolved !== source) {
        this.logger.info({ source, resolved }, "Resolved short URL to canonical URL");
      }
      return resolved || source;
    } catch (err) {
      this.logger.warn({ source, error: err && err.message ? err.message : String(err) }, "Could not resolve short URL, using original");
      return source;
    } finally {
      clearTimeout(timeoutHandle);
      if (runtime.signal) {
        runtime.signal.removeEventListener("abort", onAbort);
      }
    }
  }

  buildPinterestCanonicalFromError(url, errorText) {
    const source = String(url || "").trim();
    const text = String(errorText || "");
    if (!/pin\.it\//i.test(source)) {
      return null;
    }

    const idMatch = /\[Pinterest\]\s*(\d{5,})/i.exec(text);
    if (!idMatch || !idMatch[1]) {
      return null;
    }

    return `https://www.pinterest.com/pin/${idMatch[1]}/`;
  }

  /**
   * Quality presets for different use cases
   * Maps canonical quality profiles to yt-dlp format selectors
   */
  static QUALITY_PRESETS = {
    audio: {
      "audio-high": {
        format: "bestaudio/best",
        audioQuality: "0",
        extractAudio: true,
        audioFormat: "mp3",
      },
      "audio-medium": {
        format: "bestaudio[abr<=192]/bestaudio/best",
        audioQuality: "5",
        extractAudio: true,
        audioFormat: "mp3",
      },
      "audio-low": {
        format: "bestaudio[abr<=128]/bestaudio/best",
        audioQuality: "9",
        extractAudio: true,
        audioFormat: "mp3",
      },
      // Legacy mapping (preserved for backward compatibility)
      "high": {
        format: "bestaudio/best",
        audioQuality: "0",
        extractAudio: true,
        audioFormat: "mp3",
      },
      "medium": {
        format: "bestaudio[abr<=192]/bestaudio/best",
        audioQuality: "5",
        extractAudio: true,
        audioFormat: "mp3",
      },
      "low": {
        format: "bestaudio[abr<=128]/bestaudio/best",
        audioQuality: "9",
        extractAudio: true,
        audioFormat: "mp3",
      },
    },
    video: {
      "4k60": {
        format: "bestvideo[height<=2160][fps<=60]+bestaudio/bestvideo[height<=2160]+bestaudio/best[height<=2160]/best",
        mergeOutputFormat: "mp4",
      },
      "4k": {
        format: "bestvideo[height<=2160]+bestaudio/best[height<=2160]/best",
        mergeOutputFormat: "mp4",
      },
      "1440p60": {
        format: "bestvideo[height<=1440][fps<=60]+bestaudio/bestvideo[height<=1440]+bestaudio/best[height<=1440]/best",
        mergeOutputFormat: "mp4",
      },
      "1440p": {
        format: "bestvideo[height<=1440]+bestaudio/best[height<=1440]/best",
        mergeOutputFormat: "mp4",
      },
      "1080p60": {
        format: "bestvideo[height<=1080][fps<=60]+bestaudio/bestvideo[height<=1080]+bestaudio/best[height<=1080]/best",
        mergeOutputFormat: "mp4",
      },
      "1080p": {
        format: "bestvideo[height<=1080]+bestaudio/best[height<=1080]/best",
        mergeOutputFormat: "mp4",
      },
      "720p60": {
        format: "bestvideo[height<=720][fps<=60]+bestaudio/bestvideo[height<=720]+bestaudio/best[height<=720]/best",
        mergeOutputFormat: "mp4",
      },
      "720p": {
        format: "bestvideo[height<=720]+bestaudio/best[height<=720]/best",
        mergeOutputFormat: "mp4",
      },
      "480p": {
        format: "bestvideo[height<=480]+bestaudio/best[height<=480]/best",
        mergeOutputFormat: "mp4",
      },
      // Legacy mapping (preserved for backward compatibility)
      "high": {
        format: "bestvideo[height<=1080]+bestaudio/best[height<=1080]/best",
        mergeOutputFormat: "mp4",
      },
      "medium": {
        format: "bestvideo[height<=720]+bestaudio/best[height<=720]/best",
        mergeOutputFormat: "mp4",
      },
      "low": {
        format: "best[height<=480]/worst",
        mergeOutputFormat: "mp4",
      },
    },
  };

  /**
   * Build yt-dlp arguments with security hardening
   */
  buildDownloadArgs(url, options = {}) {
    const {
      quality = "medium",
      outputFormat = "audio", // 'audio' or 'video'
      outputPath,
      maxFilesize = null,
      platform = "generic",
      allowPlaylist = false,
      playlistEnd = null,
      targetAudioFormat = null,
      targetVideoFormat = null,
      includeSubtitles = false,
      subtitleLanguages = [],
      subtitleFormat = "vtt",
    } = options;

    const preset = VideoDownloadManager.QUALITY_PRESETS[outputFormat]?.[quality];
    if (!preset) {
      throw new Error(`Invalid quality preset: ${outputFormat}/${quality}`);
    }

    const args = [
      url,
      "--quiet",
      "--no-warnings",
      "--user-agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      "--referer", url,
      "--geo-bypass",
      "--socket-timeout", "60",
      "--retries", "5",
      "--fragment-retries", "10",
      "--retry-sleep", "2",
      "--no-continue", // Always start fresh
      "--no-part", // No .part files
      "--restrict-filenames", // Security: sanitize filenames
      "-o", path.join(outputPath, "%(title).50s.%(ext)s"), // Limit filename length
    ];

    if (allowPlaylist) {
      args.push("--yes-playlist");
      if (Number.isFinite(playlistEnd) && playlistEnd > 0) {
        args.push("--playlist-end", String(Math.floor(playlistEnd)));
      }
    } else {
      args.push("--no-playlist");
    }

    // Format selection
    if (preset.format) {
      args.push("-f", preset.format);
    }

    // Audio extraction
    if (preset.extractAudio) {
      args.push("-x");
      const effectiveAudioFormat = targetAudioFormat || preset.audioFormat;
      if (effectiveAudioFormat) {
        args.push("--audio-format", effectiveAudioFormat);
      }
      if (preset.audioQuality) {
        args.push("--audio-quality", preset.audioQuality);
      }
    }

    // Video merge format
    if (outputFormat === "video") {
      const effectiveVideoFormat = targetVideoFormat || preset.mergeOutputFormat;
      if (effectiveVideoFormat) {
        args.push("--merge-output-format", effectiveVideoFormat);
      }
    } else if (preset.mergeOutputFormat) {
      args.push("--merge-output-format", preset.mergeOutputFormat);
    }

    if (includeSubtitles) {
      args.push("--write-subs", "--write-auto-subs", "--embed-subs", "--convert-subs", subtitleFormat);
      if (Array.isArray(subtitleLanguages) && subtitleLanguages.length > 0) {
        args.push("--sub-langs", subtitleLanguages.join(","));
      }
    }

    // File size limit
    if (maxFilesize || this.config.mediaUploadLimitBytes) {
      const limit = maxFilesize || this.config.mediaUploadLimitBytes;
      args.push("--max-filesize", `${Math.floor(limit / 1024 / 1024)}M`);
    }

    // Platform-specific optimizations
    if (platform === "youtube") {
      args.push("--extractor-retries", "10");
    }

    if (this.config.ytdlpAllowInsecureTransport) {
      args.push("--no-check-certificates", "--prefer-insecure");
    }

    return args;
  }

  parseMetadataOutput(raw) {
    const content = String(raw || "").trim();
    if (!content) {
      throw new Error("No metadata output returned by yt-dlp");
    }

    const lines = content.split(/\r?\n/).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      try {
        return JSON.parse(lines[i]);
      } catch (_err) {
        // keep trying previous lines
      }
    }

    throw new Error("Unable to parse yt-dlp metadata output");
  }

  async inspectUrl(url, options = {}, runtime = {}) {
    if (runtime.signal?.aborted) {
      const err = new Error("Inspection cancelled by client");
      err.status = 499;
      throw err;
    }

    const resolvedUrl = await this.resolveCanonicalUrl(url, runtime);

    const inspectArgs = [
      resolvedUrl,
      "--skip-download",
      "--dump-single-json",
      "--no-warnings",
      "--geo-bypass",
    ];

    if (this.config.ytdlpAllowInsecureTransport) {
      inspectArgs.push("--no-check-certificates");
    }

    const playlistEnd = Number.isFinite(options.playlistEnd) ? options.playlistEnd : null;
    if (options.allowPlaylist) {
      inspectArgs.push("--yes-playlist");
      if (playlistEnd && playlistEnd > 0) {
        inspectArgs.push("--playlist-end", String(Math.floor(playlistEnd)));
      }
    } else {
      inspectArgs.push("--no-playlist");
    }

    let stdout;
    try {
      stdout = await this.ytdlp.execPromise(inspectArgs);
    } catch (err) {
      const errorText = String(err && err.message ? err.message : err);
      const canonical = this.buildPinterestCanonicalFromError(url, errorText);
      if (canonical && !options.__pinRetryDone) {
        this.logger.info({ sourceUrl: url, canonical }, "Retrying Pinterest inspect with canonical pin URL");
        return this.inspectUrl(canonical, { ...options, __pinRetryDone: true }, runtime);
      }
      throw classifyYtdlpError(errorText);
    }

    const metadata = this.parseMetadataOutput(stdout);
    const entries = Array.isArray(metadata.entries) ? metadata.entries : [];
    const qualityProfiles = buildAvailableQualityProfiles(metadata.formats);

    return {
      sourceUrl: resolvedUrl,
      id: metadata.id || null,
      title: metadata.title || null,
      uploader: metadata.uploader || metadata.channel || null,
      durationSec: Number.isFinite(metadata.duration) ? metadata.duration : null,
      webpageUrl: metadata.webpage_url || resolvedUrl,
      isPlaylist: entries.length > 0,
      entries: entries.slice(0, 200).map((entry) => ({
        id: entry && entry.id ? entry.id : null,
        title: entry && entry.title ? entry.title : null,
        durationSec: entry && Number.isFinite(entry.duration) ? entry.duration : null,
        webpageUrl: entry && entry.webpage_url ? entry.webpage_url : null,
      })),
      extractor: metadata.extractor || null,
      qualityProfiles,
      formats: Array.isArray(metadata.formats)
        ? metadata.formats.slice(0, 30).map((f) => ({
            formatId: f.format_id,
            ext: f.ext,
            resolution: f.resolution || null,
            vcodec: f.vcodec || null,
            acodec: f.acodec || null,
          }))
        : [],
    };
  }

  async buildZipOutput(workingDir, files) {
    const zip = new JSZip();
    const manifest = [];

    for (const fileName of files) {
      const fullPath = path.join(workingDir, fileName);
      const content = await fs.readFile(fullPath);
      zip.file(this.sanitizeFilename(fileName), content);
      manifest.push({
        fileName: this.sanitizeFilename(fileName),
        sizeBytes: content.length,
      });
    }

    zip.file("manifest.json", JSON.stringify({
      createdAt: new Date().toISOString(),
      fileCount: files.length,
      files: manifest,
    }, null, 2));

    const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    return {
      buffer,
      outputName: `playlist-${crypto.randomUUID()}.zip`,
      contentType: "application/zip",
      stats: {
        outputBytes: buffer.length,
        method: "yt-dlp-playlist-zip",
        itemCount: files.length,
      },
    };
  }

  /**
   * Download with intelligent quality fallback
   */
  async downloadWithFallback(url, options, runtime) {
    // Use the quality from options (now a canonical profile like "720p", "1080p", etc.)
    // Only fallback to lower quality if the first attempt fails
    const qualityFallbacks = options.quality && options.quality.startsWith("audio-")
      ? ["audio-high", "audio-medium", "audio-low"]
      : ["1080p60", "1080p", "720p60", "720p", "480p"];
    
    // Ensure we try the requested quality first
    const requestedQuality = options.quality || "720p";
    const qualities = [requestedQuality];
    
    // Add fallbacks that haven't been tried yet
    for (const q of qualityFallbacks) {
      if (q !== requestedQuality && !qualities.includes(q)) {
        qualities.push(q);
      }
    }

    let lastError;

    for (const quality of qualities) {
      try {
        this.logger.info({ url, quality, outputFormat: options.outputFormat }, "Attempting download");
        return await this.executeDownload(url, { ...options, quality }, runtime);
      } catch (err) {
        lastError = err;
        
        this.logger.warn(
          {
            url,
            quality,
            error: err.message,
            classification: err.classification,
            retryable: err.retryable,
          },
          "Download attempt failed"
        );

        // Don't retry on non-retryable errors
        if (!err.retryable && err.classification !== "NoFormatAvailable") {
          throw err;
        }

        // Continue to lower quality
      }
    }

    throw lastError || new Error("Download failed at all quality levels");
  }

  /**
   * Core download execution with timeout and abort handling
   */
  async executeDownload(url, options, runtime = {}) {
    const {
      outputFormat = "audio",
      quality = "medium",
      timeout = this.config.ytdlpTimeoutMs || 300000,
    } = options;

    // Create temp directory
    const workingDir = await fs.mkdtemp(path.join(os.tmpdir(), "toolspage-ytdlp-"));
    
    try {
      // Check for abort signal
      if (runtime.signal?.aborted) {
        const err = new Error("Download cancelled by client");
        err.status = 499;
        throw err;
      }

      const resolvedUrl = await this.resolveCanonicalUrl(url, runtime);

      const args = this.buildDownloadArgs(resolvedUrl, {
        ...options,
        outputPath: workingDir,
      });

      this.logger.debug({ args: args.join(" ") }, "Executing yt-dlp");

      // Execute with timeout, abort handling, and fine-grained progress events.
      const reportProgress = typeof runtime.reportProgress === "function"
        ? runtime.reportProgress
        : null;
      let lastReportedPercent = -1;
      const stage = outputFormat === "audio" ? "extracting-audio" : "downloading";

      const emitProgress = (percent, extra = {}) => {
        if (!reportProgress) {
          return;
        }
        const clamped = clampPercent(percent);
        if (clamped === null) {
          return;
        }
        // Reserve 0-24 for queueing/setup and 85+ for output storage.
        const mappedProgress = Math.round(25 + (clamped * 0.55));
        if (mappedProgress <= lastReportedPercent) {
          return;
        }
        lastReportedPercent = mappedProgress;
        reportProgress({
          status: "running",
          stage,
          progress: mappedProgress,
          downloadPercent: Number(clamped.toFixed(1)),
          ...extra,
        });
      };

      let abortedByClient = false;
      let timedOut = false;
      let stderrOutput = "";
      const timeoutController = new AbortController();
      const onClientAbort = () => {
        abortedByClient = true;
        timeoutController.abort();
      };

      const timeoutHandle = setTimeout(() => {
        timedOut = true;
        timeoutController.abort();
      }, timeout);

      if (runtime.signal) {
        runtime.signal.addEventListener("abort", onClientAbort);
      }

      const emitter = this.ytdlp.exec(args, undefined, timeoutController.signal);

      try {
        await new Promise((resolve, reject) => {
          emitter.on("progress", (progress) => {
            const percent = clampPercent(progress && progress.percent);
            if (percent !== null) {
              emitProgress(percent, {
                speed: progress.currentSpeed || null,
                eta: progress.eta || null,
                totalSize: progress.totalSize || null,
              });
            }
          });

          emitter.on("ytDlpEvent", (_eventType, eventData) => {
            const text = String(eventData || "");
            if (text) {
              stderrOutput += `${text}\n`;
            }
            const parsed = parsePercentFromText(text);
            if (parsed !== null) {
              emitProgress(parsed);
            }
          });

          emitter.on("error", (err) => {
            reject(err);
          });

          emitter.on("close", (code) => {
            if (code === 0) {
              emitProgress(100);
              resolve();
              return;
            }
            reject(new Error(stderrOutput || `yt-dlp exited with code ${code}`));
          });
        });
      } catch (err) {
        if (abortedByClient || runtime.signal?.aborted) {
          const abortErr = new Error("Download cancelled by client");
          abortErr.status = 499;
          throw abortErr;
        }

        if (timedOut) {
          throw new DownloadError("Download timed out", "TimeoutError");
        }

        if (err instanceof DownloadError) {
          throw err;
        }

        const errorText = String((err && err.message) || stderrOutput || err);
        const canonical = this.buildPinterestCanonicalFromError(url, errorText);
        if (canonical && !options.__pinRetryDone) {
          this.logger.info({ sourceUrl: url, canonical }, "Retrying Pinterest download with canonical pin URL");
          return this.executeDownload(canonical, { ...options, __pinRetryDone: true }, runtime);
        }

        throw classifyYtdlpError(errorText);
      } finally {
        clearTimeout(timeoutHandle);
        if (runtime.signal) {
          runtime.signal.removeEventListener("abort", onClientAbort);
        }
      }

      // Find the downloaded file
      const files = await fs.readdir(workingDir);
      if (files.length === 0) {
        throw new DownloadError("No output file produced", "NoFormatAvailable");
      }


      // Prefer returning a single merged .mp4 if possible
      const videoFile = files.find(f => f.match(/\.mp4$/i));
      const audioFile = files.find(f => f.match(/\.(m4a|webm|opus|aac|ogg|wav)$/i));
      const configuredUrlLimitBytes = Number(this.config.mediaUrlOutputLimitBytes);
      const configuredUrlLimitMb = Number(this.config.mediaUrlOutputLimitMb);
      const maxOutputBytes = Number.isFinite(configuredUrlLimitBytes) ? configuredUrlLimitBytes : 0;
      const maxOutputMb = Number.isFinite(configuredUrlLimitMb) ? configuredUrlLimitMb : 0;
      const assertOutputSizeLimit = (buffer) => {
        if (maxOutputBytes > 0 && buffer.length > maxOutputBytes) {
          throw new DownloadError(
            `Downloaded file (${(buffer.length / 1024 / 1024).toFixed(1)}MB) exceeds configured URL output limit (${maxOutputMb}MB). Increase MEDIA_URL_OUTPUT_LIMIT_MB or choose a lower quality.`,
            "FileSizeExceeded"
          );
        }
      };
      if (videoFile && audioFile) {
        const mergedFile = videoFile.replace(/\.mp4$/i, ".merged.mp4");
        const ffmpegArgs = [
          "-i", path.join(workingDir, videoFile),
          "-i", path.join(workingDir, audioFile),
          "-c:v", "copy",
          "-c:a", "aac",
          "-movflags", "+faststart",
          "-y", path.join(workingDir, mergedFile),
        ];
        const { runFfmpeg } = require("./media");
        await runFfmpeg(ffmpegArgs, this.config, runtime);
        let mergedPath = path.join(workingDir, mergedFile);
        let playable = await isPlayableMediaFile(mergedPath, this.config, runtime);
        if (!playable) {
          // Fallback: re-encode to force a clean playable MP4 container.
          const repairedFile = mergedFile.replace(/\.mp4$/i, ".repaired.mp4");
          await runFfmpeg([
            "-i", path.join(workingDir, videoFile),
            "-i", path.join(workingDir, audioFile),
            "-c:v", "libx264",
            "-preset", "veryfast",
            "-crf", "23",
            "-pix_fmt", "yuv420p",
            "-c:a", "aac",
            "-movflags", "+faststart",
            "-y", path.join(workingDir, repairedFile),
          ], this.config, runtime);
          mergedPath = path.join(workingDir, repairedFile);
          playable = await isPlayableMediaFile(mergedPath, this.config, runtime);
          if (!playable) {
            throw new DownloadError(
              "Download completed but output container is not playable. Please retry with another quality/profile.",
              "NoFormatAvailable"
            );
          }
        }
        const buffer = await fs.readFile(mergedPath);
        assertOutputSizeLimit(buffer);
        return {
          buffer,
          outputName: this.getCleanMp4OutputName(videoFile),
          contentType: "video/mp4",
          stats: {
            outputBytes: buffer.length,
            method: "yt-dlp-ffmpeg-merge",
            quality,
            platform: URLValidator.detectPlatform(resolvedUrl),
          },
        };
      }

      // If only one .mp4 file exists, return it
      if (videoFile && files.filter(f => f.match(/\.mp4$/i)).length === 1) {
        const outputPath = path.join(workingDir, videoFile);
        const playable = await isPlayableMediaFile(outputPath, this.config, runtime);
        if (!playable) {
          throw new DownloadError(
            "Downloaded video container is not playable. Please retry with another quality/profile.",
            "NoFormatAvailable"
          );
        }
        const buffer = await fs.readFile(outputPath);
        assertOutputSizeLimit(buffer);
        return {
          buffer,
          outputName: this.getCleanMp4OutputName(videoFile),
          contentType: "video/mp4",
          stats: {
            outputBytes: buffer.length,
            method: "yt-dlp",
            quality,
            platform: URLValidator.detectPlatform(resolvedUrl),
          },
        };
      }

      // Otherwise, fallback to ZIP
      if (files.length > 1) {
        const zipResult = await this.buildZipOutput(workingDir, files);
        return {
          ...zipResult,
          stats: {
            ...zipResult.stats,
            quality,
            platform: URLValidator.detectPlatform(resolvedUrl),
          },
        };
      }

      const outputFile = files[0];
      const outputPath = path.join(workingDir, outputFile);
      const buffer = await fs.readFile(outputPath);

      // Validate size
      assertOutputSizeLimit(buffer);

      // Determine content type
      const ext = path.extname(outputFile).toLowerCase();
      const contentType = this.getContentType(ext, outputFormat);

      return {
        buffer,
        outputName: this.sanitizeFilename(outputFile),
        contentType,
        stats: {
          outputBytes: buffer.length,
          method: "yt-dlp",
          quality,
          platform: URLValidator.detectPlatform(resolvedUrl),
        },
      };
    } finally {
      // Cleanup temp directory
      await fs.rm(workingDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  getContentType(ext, outputFormat) {
    const contentTypes = {
      ".mp3": "audio/mpeg",
      ".mp4": "video/mp4",
      ".webm": "video/webm",
      ".m4a": "audio/mp4",
      ".opus": "audio/opus",
      ".wav": "audio/wav",
    };

    return contentTypes[ext] || (outputFormat === "audio" ? "audio/mpeg" : "video/mp4");
  }

  sanitizeFilename(filename) {
    return filename
      .replace(/[^a-zA-Z0-9._-]/g, "-")
      .replace(/-+/g, "-")
      .substring(0, 100);
  }

  getCleanMp4OutputName(sourceFilename) {
    const originalBase = path.basename(
      String(sourceFilename || "video"),
      path.extname(String(sourceFilename || "video"))
    );
    const cleanedBase = originalBase
      .replace(/\.merged(?:\.repaired)?$/i, "")
      .replace(/\.repaired$/i, "")
      .replace(/\.f\d+$/i, "")
      .replace(/[._-]+$/g, "");
    const base = cleanedBase || "video";
    return this.sanitizeFilename(`${base}.mp4`);
  }

  /**
   * Download with retry logic
   */
  async downloadWithRetry(url, options, runtime, maxAttempts = 3) {
    let lastError;
    let backoffMs = 2000;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this.downloadWithFallback(url, options, runtime);
      } catch (err) {
        lastError = err;
        const shouldRetry = err.retryable && attempt < maxAttempts;

        this.logger.warn(
          {
            url,
            attempt,
            maxAttempts,
            error: err.message,
            classification: err.classification,
            retrying: shouldRetry,
          },
          "Download attempt failed"
        );

        if (!shouldRetry) {
          throw err;
        }

        // Exponential backoff
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        backoffMs *= 2;
      }
    }

    throw lastError;
  }
}

module.exports = {
  VideoDownloadManager,
  URLValidator,
  DownloadError,
};
