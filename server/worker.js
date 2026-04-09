const config = require("./config");
const logger = require("./logger");
const { createJobManager } = require("./jobs");
const { createOutputStore } = require("./output-store");
const { createQueueHandlers } = require("./queue-handlers");
const { ensureMediaRuntime } = require("./media");

async function startWorker() {
  await ensureMediaRuntime(config);

  if (!config.redisUrl) {
    logger.error("REDIS_URL is required for dedicated worker mode");
    process.exit(1);
  }

  const outputStore = createOutputStore(config, logger);
  const handlers = createQueueHandlers(outputStore, config, logger);

  const pdfJobs = await createJobManager({
    ttlMs: config.jobTtlMs,
    cleanupMs: config.jobCleanupMs,
    concurrency: Math.max(1, config.pdfJobConcurrency),
    logger,
    handlers,
    redisUrl: config.redisUrl,
    queueName: config.pdfQueueName,
    redisConnectTimeoutMs: config.redisConnectTimeoutMs,
    redisWorkerEnabled: true,
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
    redisWorkerEnabled: true,
  });

  if (pdfJobs.backend !== "redis" || mediaJobs.backend !== "redis") {
    logger.error("Dedicated worker requires Redis backend");
    process.exit(1);
  }

  logger.info({
    queues: {
      pdf: config.pdfQueueName,
      media: config.mediaQueueName,
    },
    concurrency: {
      pdf: config.pdfJobConcurrency,
      media: config.mediaJobConcurrency,
    },
  }, "Toolspage worker started");

  const stop = async () => {
    await Promise.all([pdfJobs.stop(), mediaJobs.stop()]);
    process.exit(0);
  };

  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

startWorker().catch((error) => {
  logger.error({ err: error }, "Failed to start Toolspage worker");
  process.exit(1);
});
