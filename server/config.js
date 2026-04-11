const path = require("path");

function parseSizeMb(value, fallbackMb) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallbackMb;
  }
  return parsed;
}

function parseCsv(value) {
  if (!value) {
    return [];
  }
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const normalized = String(value).toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on";
}

function parseSizeMbOrZero(value, fallbackMb) {
  if (value === "0" || value === 0) {
    return 0;
  }
  return parseSizeMb(value, fallbackMb);
}

const uploadLimitMb = parseSizeMb(process.env.FILE_UPLOAD_LIMIT_MB, 25);
const asyncThresholdMb = parseSizeMb(process.env.ASYNC_THRESHOLD_MB, 8);
const mediaUploadLimitMb = parseSizeMb(process.env.MEDIA_UPLOAD_LIMIT_MB, uploadLimitMb);
const mediaUrlOutputLimitMb = parseSizeMbOrZero(process.env.MEDIA_URL_OUTPUT_LIMIT_MB, 0);
const jobConcurrency = Number.parseInt(process.env.JOB_CONCURRENCY || "2", 10);
const env = process.env.NODE_ENV || "development";
const isProduction = env === "production";
const apiKey = process.env.API_KEY || "";
const corsOrigins = parseCsv(process.env.CORS_ORIGINS);
const corsAllowAll = parseBoolean(process.env.CORS_ALLOW_ALL, false) || corsOrigins.includes("*");
const strictProductionConfig = parseBoolean(process.env.STRICT_PRODUCTION_CONFIG, true);
const outputSigningSecret = process.env.OUTPUT_SIGNING_SECRET || apiKey;

if (isProduction && strictProductionConfig) {
  if (!apiKey) {
    throw new Error("API_KEY is required when NODE_ENV=production");
  }
  if (!corsOrigins.length && !corsAllowAll) {
    throw new Error("CORS_ORIGINS must be set when NODE_ENV=production");
  }
  if (!outputSigningSecret || String(outputSigningSecret).length < 16) {
    throw new Error("OUTPUT_SIGNING_SECRET (or API_KEY of at least 16 chars) is required in production");
  }
}

module.exports = {
  env,
  isProduction,
  port: Number.parseInt(process.env.PORT || "8080", 10),
  trustProxy: process.env.TRUST_PROXY === "true",
  rateLimitWindowMs: Number.parseInt(process.env.RATE_LIMIT_WINDOW_MS || String(15 * 60 * 1000), 10),
  rateLimitMax: Number.parseInt(process.env.RATE_LIMIT_MAX || "100", 10),
  distributedRateLimit: process.env.DISTRIBUTED_RATE_LIMIT === "true",
  uploadLimitMb,
  uploadLimitBytes: uploadLimitMb * 1024 * 1024,
  mediaUploadLimitMb,
  mediaUploadLimitBytes: mediaUploadLimitMb * 1024 * 1024,
  mediaUrlOutputLimitMb,
  mediaUrlOutputLimitBytes: mediaUrlOutputLimitMb * 1024 * 1024,
  asyncThresholdMb,
  asyncThresholdBytes: asyncThresholdMb * 1024 * 1024,
  jobTtlMs: Number.parseInt(process.env.JOB_TTL_MS || String(30 * 60 * 1000), 10),
  jobCleanupMs: Number.parseInt(process.env.JOB_CLEANUP_MS || String(60 * 1000), 10),
  jobConcurrency,
  pdfJobConcurrency: Number.parseInt(process.env.PDF_JOB_CONCURRENCY || String(jobConcurrency), 10),
  mediaJobConcurrency: Number.parseInt(process.env.MEDIA_JOB_CONCURRENCY || String(jobConcurrency), 10),
  pdfQueueMaxPending: Number.parseInt(process.env.PDF_QUEUE_MAX_PENDING || "0", 10),
  mediaQueueMaxPending: Number.parseInt(process.env.MEDIA_QUEUE_MAX_PENDING || "0", 10),
  redisUrl: process.env.REDIS_URL || "",
  queueName: process.env.QUEUE_NAME || "toolspage-jobs",
  pdfQueueName: process.env.PDF_QUEUE_NAME || `${process.env.QUEUE_NAME || "toolspage-jobs"}-pdf`,
  mediaQueueName: process.env.MEDIA_QUEUE_NAME || `${process.env.QUEUE_NAME || "toolspage-jobs"}-media`,
  redisConnectTimeoutMs: Number.parseInt(process.env.REDIS_CONNECT_TIMEOUT_MS || "3000", 10),
  runQueueWorkerInApi: process.env.RUN_QUEUE_WORKER_IN_API !== "false",
  storageProvider: process.env.STORAGE_PROVIDER || "local",
  outputLocalDir: path.resolve(process.env.OUTPUT_LOCAL_DIR || path.join(".", "data", "outputs")),
  outputPublicBaseUrl: process.env.OUTPUT_PUBLIC_BASE_URL || "",
  signedUrlTtlSec: Number.parseInt(process.env.SIGNED_URL_TTL_SEC || "900", 10),
  outputRetentionSec: Number.parseInt(process.env.OUTPUT_RETENTION_SEC || String(24 * 60 * 60), 10),
  outputAuditLogPath: process.env.OUTPUT_AUDIT_LOG_PATH || path.resolve("./data/output-audit.log"),
  s3Bucket: process.env.S3_BUCKET || "",
  s3Region: process.env.S3_REGION || "us-east-1",
  s3Endpoint: process.env.S3_ENDPOINT || "",
  s3ForcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
  s3AccessKeyId: process.env.S3_ACCESS_KEY_ID || "",
  s3SecretAccessKey: process.env.S3_SECRET_ACCESS_KEY || "",
  ocrProvider: process.env.OCR_PROVIDER || "none",
  ocrSpaceApiKey: process.env.OCR_SPACE_API_KEY || "",
  compressEngine: process.env.COMPRESS_ENGINE || "auto",
  ghostscriptCommand: process.env.GHOSTSCRIPT_COMMAND || "gs",
  enableClamScan: process.env.ENABLE_CLAM_SCAN === "true",
  clamscanCommand: process.env.CLAMSCAN_COMMAND || "clamscan",
  ffmpegCommand: process.env.FFMPEG_COMMAND || "ffmpeg",
  ffprobeCommand: process.env.FFPROBE_COMMAND || "ffprobe",
  ffmpegRequired: parseBoolean(process.env.FFMPEG_REQUIRED, true),
  ffmpegTimeoutMs: Number.parseInt(process.env.FFMPEG_TIMEOUT_MS || "180000", 10),
  ffprobeTimeoutMs: Number.parseInt(process.env.FFPROBE_TIMEOUT_MS || "20000", 10),
  mediaMaxDurationSec: Number.parseInt(process.env.MEDIA_MAX_DURATION_SEC || "1800", 10),
  ytdlpBinary: process.env.YTDLP_BINARY || "yt-dlp",
  ytdlpTimeoutMs: Number.parseInt(process.env.YTDLP_TIMEOUT_MS || "300000", 10),
  ytdlpDefaultQuality: process.env.YTDLP_DEFAULT_QUALITY || "4k60",
  ytdlpPlaylistMaxItems: Number.parseInt(process.env.YTDLP_PLAYLIST_MAX_ITEMS || "25", 10),
  ytdlpAllowInsecureTransport: parseBoolean(process.env.YTDLP_ALLOW_INSECURE_TRANSPORT, false),
  mediaRequireRightsConfirmation: parseBoolean(process.env.MEDIA_REQUIRE_RIGHTS_CONFIRMATION, false),
  mediaVideoExtensions: parseCsv(process.env.MEDIA_VIDEO_EXTENSIONS || ".mp4,.mov,.mkv,.webm,.m4v").map((item) => item.toLowerCase()),
  mediaAudioExtensions: parseCsv(process.env.MEDIA_AUDIO_EXTENSIONS || ".mp3,.wav,.aac,.ogg,.m4a,.flac").map((item) => item.toLowerCase()),
  mediaAudioOutputFormats: parseCsv(process.env.MEDIA_AUDIO_OUTPUT_FORMATS || "mp3,wav,aac,ogg,m4a").map((item) => item.toLowerCase()),
  mediaUrlIngestEnabled: parseBoolean(process.env.MEDIA_URL_INGEST_ENABLED, true),
  mediaUrlAllowlist: parseCsv(process.env.MEDIA_URL_ALLOWLIST).map((item) => item.toLowerCase()),
  apiKey,
  outputSigningSecret,
  strictProductionConfig,
  corsAllowAll,
  corsOrigins,
  allowInMemoryQueueFallback: parseBoolean(process.env.ALLOW_IN_MEMORY_QUEUE_FALLBACK, !isProduction),
  staticRoot: path.resolve(__dirname, ".."),
};
