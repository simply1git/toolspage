const cors = require("cors");
const helmet = require("helmet");
const pinoHttp = require("pino-http");
const multer = require("multer");
const crypto = require("crypto");
const IORedis = require("ioredis");

const config = require("./config");
const logger = require("./logger");

function requestIdMiddleware(req, res, next) {
  const existing = req.header("x-request-id");
  const requestId = existing || crypto.randomUUID();
  req.requestId = requestId;
  res.setHeader("x-request-id", requestId);
  next();
}

function corsMiddleware() {
  if (!config.corsOrigins.length) {
    return cors({
      origin: true,
      methods: ["GET", "POST", "OPTIONS"],
      allowedHeaders: ["Content-Type", "X-Request-Id", "X-API-Key", "X-Requested-With"],
      exposedHeaders: ["X-Request-Id", "Content-Disposition", "X-Compression-Ratio", "X-Compression-Method"],
    });
  }

  return cors({
    origin(origin, callback) {
      if (!origin || config.corsOrigins.includes(origin)) {
        callback(null, true);
        return;
      }

      callback(new Error("Origin is not allowed by CORS policy"));
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "X-Request-Id", "X-API-Key", "X-Requested-With"],
    exposedHeaders: ["X-Request-Id", "Content-Disposition", "X-Compression-Ratio", "X-Compression-Method"],
  });
}

function rateLimiter() {
  const windowMs = config.rateLimitWindowMs;
  const max = config.rateLimitMax;
  const buckets = new Map();
  let lastSweepAt = 0;
  const redis = config.distributedRateLimit && config.redisUrl
    ? new IORedis(config.redisUrl, {
        maxRetriesPerRequest: 1,
        enableReadyCheck: true,
        connectTimeout: config.redisConnectTimeoutMs,
      })
    : null;

  if (redis) {
    redis.on("error", (err) => {
      logger.warn({ err }, "Distributed rate limiter redis error, using fallback behavior");
    });
  }

  return async (req, res, next) => {
    const key = req.ip || req.socket.remoteAddress || "unknown";
    const now = Date.now();

    if (redis) {
      try {
        const bucketKey = `toolspage:rate:${key}`;
        const current = await redis.incr(bucketKey);
        if (current === 1) {
          await redis.pexpire(bucketKey, windowMs);
        }

        if (current > max) {
          const ttl = await redis.pttl(bucketKey);
          const retryAfterSec = Math.max(1, Math.ceil(ttl / 1000));
          res.setHeader("retry-after", String(retryAfterSec));
          res.status(429).json({ ok: false, error: "Rate limit exceeded", retryAfterSec });
          return;
        }

        next();
        return;
      } catch (err) {
        logger.warn({ err }, "Distributed rate limiter failed; using in-memory fallback");
      }
    }

    if (now - lastSweepAt > windowMs) {
      for (const [bucketKey, bucket] of buckets.entries()) {
        if (!bucket || now > bucket.resetAt) {
          buckets.delete(bucketKey);
        }
      }
      lastSweepAt = now;
    }

    const current = buckets.get(key);

    if (!current || now > current.resetAt) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      next();
      return;
    }

    current.count += 1;
    if (current.count > max) {
      const retryAfterSec = Math.ceil((current.resetAt - now) / 1000);
      res.setHeader("retry-after", String(retryAfterSec));
      res.status(429).json({
        ok: false,
        error: "Rate limit exceeded",
        retryAfterSec,
      });
      return;
    }

    next();
  };
}

function apiKeyMiddleware() {
  if (!config.apiKey) {
    return (req, res, next) => next();
  }

  return (req, res, next) => {
    const provided = String(req.header("x-api-key") || req.query.apiKey || "");
    const expected = String(config.apiKey || "");
    const providedBuf = Buffer.from(provided, "utf8");
    const expectedBuf = Buffer.from(expected, "utf8");
    if (providedBuf.length === expectedBuf.length && crypto.timingSafeEqual(providedBuf, expectedBuf)) {
      next();
      return;
    }

    res.status(401).json({ ok: false, error: "Unauthorized" });
  };
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: config.uploadLimitBytes,
    files: 8,
  },
});

const uploadMedia = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: Math.min(config.uploadLimitBytes, config.mediaUploadLimitBytes),
    files: 2,
  },
});

function uploadErrorHandler(err, req, res, next) {
  if (!err) {
    next();
    return;
  }

  if (err.code === "LIMIT_FILE_SIZE") {
    const isMediaRoute = req && typeof req.path === "string" && /\/api\/v1\/(tools|jobs)\/(video|audio)-/i.test(req.path);
    const maxMb = isMediaRoute
      ? Math.min(config.uploadLimitMb, config.mediaUploadLimitMb)
      : config.uploadLimitMb;
    res.status(413).json({
      ok: false,
      error: `File too large. Max ${maxMb}MB.`,
    });
    return;
  }

  res.status(400).json({ ok: false, error: err.message || "Upload error" });
}

function notFoundHandler(req, res) {
  res.status(404).json({ ok: false, error: "Not found" });
}

function errorHandler(err, req, res, next) {
  const status = err.status && Number.isInteger(err.status) ? err.status : 500;
  req.log.error({ err }, "Unhandled API error");
  const message = status >= 500 ? "Internal server error" : err.message;
  res.status(status).json({ ok: false, error: message, requestId: req.requestId });
}

module.exports = {
  helmetMiddleware: helmet({
    crossOriginResourcePolicy: false,
    contentSecurityPolicy: false,
  }),
  corsMiddleware,
  pinoMiddleware: pinoHttp({ logger }),
  requestIdMiddleware,
  rateLimiter,
  apiKeyMiddleware,
  upload,
  uploadMedia,
  uploadErrorHandler,
  notFoundHandler,
  errorHandler,
};
