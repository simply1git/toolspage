const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");

const ONE_HOUR = 60 * 60 * 1000;
const ONE_DAY = 24 * ONE_HOUR;

async function cleanStaleFiles(directoryPath, prefix = "", maxAgeMs = ONE_DAY, logger = console) {
  try {
    const entries = await fs.readdir(directoryPath, { withFileTypes: true }).catch(() => []);
    const now = Date.now();
    let deletedCount = 0;

    for (const entry of entries) {
      if (prefix && !entry.name.startsWith(prefix)) {
        continue;
      }

      const fullPath = path.join(directoryPath, entry.name);
      try {
        const stats = await fs.stat(fullPath);
        if (now - stats.mtimeMs > maxAgeMs) {
          if (entry.isDirectory()) {
            await fs.rm(fullPath, { recursive: true, force: true });
          } else {
            await fs.unlink(fullPath);
          }
          deletedCount++;
        }
      } catch (err) {
        logger.warn({ path: fullPath, err: err.message }, "Failed to stat or delete stale file");
      }
    }

    if (deletedCount > 0) {
      logger.info({ directoryPath, deletedCount, maxAgeHrs: maxAgeMs / ONE_HOUR }, "Pruned stale files");
    }
  } catch (globalErr) {
    logger.error({ directoryPath, err: globalErr.message }, "Error during cleanup cycle");
  }
}

function startStorageJanitor(config, logger) {
  const outputDir = String(config.outputLocalDir || "/data/outputs");
  const tmpDir = os.tmpdir();

  logger.info({ outputDir, tmpDir }, "Starting Storage Janitor cron task");

  // Run cleanup every hour
  const timer = setInterval(async () => {
    // Clean old final outputs
    await cleanStaleFiles(outputDir, "", ONE_DAY, logger);
    // Clean old system temp media processing folders
    await cleanStaleFiles(tmpDir, "toolspage-", ONE_DAY, logger);
  }, ONE_HOUR);

  return {
    stop: () => clearInterval(timer)
  };
}

module.exports = { startStorageJanitor };
