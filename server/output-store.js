const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

function sanitizeName(name) {
  return String(name || "output.bin").replace(/[^a-zA-Z0-9._-]/g, "_");
}

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function createLocalStore({ outputLocalDir, outputPublicBaseUrl, signedUrlTtlSec, outputRetentionSec, outputAuditLogPath, outputSigningSecret }) {
  const signingSecret = outputSigningSecret || "";

  function normalizeStorageKey(storageKey) {
    const key = String(storageKey || "").replace(/\\/g, "/").replace(/^\/+/, "");
    if (!key || key.includes("\0")) {
      const err = new Error("Invalid storage key");
      err.status = 400;
      throw err;
    }
    const normalized = path.posix.normalize(key);
    if (normalized.startsWith("../") || normalized === ".." || path.isAbsolute(normalized)) {
      const err = new Error("Invalid storage key");
      err.status = 400;
      throw err;
    }
    return normalized;
  }

  function resolveLocalPath(storageKey) {
    const normalizedKey = normalizeStorageKey(storageKey);
    const rootPath = path.resolve(outputLocalDir);
    const fullPath = path.resolve(rootPath, normalizedKey);
    if (!fullPath.startsWith(`${rootPath}${path.sep}`) && fullPath !== rootPath) {
      const err = new Error("Invalid storage key");
      err.status = 400;
      throw err;
    }
    return { fullPath, normalizedKey };
  }

  function signDownload(storageKey, expiresAtSec) {
    return crypto
      .createHmac("sha256", signingSecret)
      .update(`${storageKey}:${expiresAtSec}`)
      .digest("hex");
  }

  async function ensureDir() {
    await fs.mkdir(outputLocalDir, { recursive: true });
    if (outputAuditLogPath) {
      await fs.mkdir(path.dirname(outputAuditLogPath), { recursive: true });
    }
  }

  async function writeAudit(event, fields) {
    if (!outputAuditLogPath) {
      return;
    }

    const line = JSON.stringify({
      ts: new Date().toISOString(),
      event,
      ...fields,
    }) + "\n";
    await fs.appendFile(outputAuditLogPath, line, "utf8");
  }

  async function save({ buffer, outputName, contentType }) {
    await ensureDir();
    const key = `${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}-${sanitizeName(outputName)}`;
    const fullPath = path.join(outputLocalDir, key);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, buffer);
    await writeAudit("output_saved", { storageKey: key, outputName, sizeBytes: buffer.length });
    return { storageKey: key, outputName, contentType, sizeBytes: buffer.length };
  }

  async function load(storageKey) {
    const { fullPath, normalizedKey } = resolveLocalPath(storageKey);
    const buffer = await fs.readFile(fullPath);
    await writeAudit("output_loaded", { storageKey: normalizedKey, sizeBytes: buffer.length });
    return buffer;
  }

  async function getDownloadUrl(storageKey) {
    if (!outputPublicBaseUrl) {
      return null;
    }

    const base = outputPublicBaseUrl.replace(/\/$/, "");
    const normalizedKey = normalizeStorageKey(storageKey);
    const expiresAt = Math.floor(Date.now() / 1000) + Math.max(30, Number(signedUrlTtlSec) || 900);
    const sig = signDownload(normalizedKey, expiresAt);
    return `${base}/api/v1/outputs/${encodeURIComponent(normalizedKey)}?expires=${expiresAt}&sig=${sig}`;
  }

  function verifySignedDownload(storageKey, query) {
    if (!signingSecret) {
      return false;
    }
    const normalizedKey = normalizeStorageKey(storageKey);
    const expiresRaw = query && query.expires ? Number(query.expires) : NaN;
    const sig = String((query && query.sig) || "");
    if (!Number.isFinite(expiresRaw) || expiresRaw < Math.floor(Date.now() / 1000) || !sig) {
      return false;
    }
    const expected = signDownload(normalizedKey, Math.floor(expiresRaw));
    const providedBuf = Buffer.from(sig, "utf8");
    const expectedBuf = Buffer.from(expected, "utf8");
    return providedBuf.length === expectedBuf.length && crypto.timingSafeEqual(providedBuf, expectedBuf);
  }

  return {
    provider: "local",
    save,
    load,
    getDownloadUrl,
    verifySignedDownload,
    async cleanupExpired() {
      const retentionSec = Number.isFinite(outputRetentionSec) ? outputRetentionSec : 24 * 60 * 60;
      const cutoff = Date.now() - retentionSec * 1000;
      const root = outputLocalDir;

      async function walk(dir) {
        const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
        let deleted = 0;
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            deleted += await walk(fullPath);
            continue;
          }

          const stat = await fs.stat(fullPath).catch(() => null);
          if (!stat) continue;
          if (stat.mtimeMs < cutoff) {
            await fs.unlink(fullPath).catch(() => {});
            deleted += 1;
            const key = path.relative(root, fullPath).replace(/\\/g, "/");
            await writeAudit("output_deleted", { storageKey: key, reason: "retention_expired" });
          }
        }
        return deleted;
      }

      return walk(root);
    },
  };
}

function createS3Store({
  s3Bucket,
  s3Region,
  s3Endpoint,
  s3ForcePathStyle,
  s3AccessKeyId,
  s3SecretAccessKey,
  signedUrlTtlSec,
}) {
  const hasCreds = Boolean(s3AccessKeyId && s3SecretAccessKey);
  const client = new S3Client({
    region: s3Region,
    endpoint: s3Endpoint || undefined,
    forcePathStyle: s3ForcePathStyle,
    credentials: hasCreds
      ? {
          accessKeyId: s3AccessKeyId,
          secretAccessKey: s3SecretAccessKey,
        }
      : undefined,
  });

  async function save({ buffer, outputName, contentType }) {
    const key = `${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}-${sanitizeName(outputName)}`;
    await client.send(new PutObjectCommand({
      Bucket: s3Bucket,
      Key: key,
      Body: buffer,
      ContentType: contentType,
    }));
    return { storageKey: key, outputName, contentType, sizeBytes: buffer.length };
  }

  async function load(storageKey) {
    const out = await client.send(new GetObjectCommand({
      Bucket: s3Bucket,
      Key: storageKey,
    }));
    return streamToBuffer(out.Body);
  }

  async function getDownloadUrl(storageKey) {
    const command = new GetObjectCommand({
      Bucket: s3Bucket,
      Key: storageKey,
    });
    return getSignedUrl(client, command, { expiresIn: signedUrlTtlSec });
  }

  return {
    provider: "s3",
    save,
    load,
    getDownloadUrl,
    verifySignedDownload() {
      return false;
    },
    async cleanupExpired() {
      return 0;
    },
  };
}

function createOutputStore(config, logger) {
  if (config.storageProvider === "s3") {
    if (!config.s3Bucket) {
      throw new Error("S3_BUCKET is required when STORAGE_PROVIDER=s3");
    }

    logger.info({ bucket: config.s3Bucket }, "Output store provider: s3");
    return createS3Store(config);
  }

  logger.info({ dir: config.outputLocalDir }, "Output store provider: local");
  return createLocalStore(config);
}

module.exports = {
  createOutputStore,
};
