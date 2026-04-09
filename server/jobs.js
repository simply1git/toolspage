const crypto = require("crypto");
const { Queue, Worker, QueueEvents } = require("bullmq");
const IORedis = require("ioredis");

function toIso(value) {
  return value ? new Date(value).toISOString() : null;
}

function mapJobState(state) {
  if (state === "completed") return "succeeded";
  if (state === "active") return "running";
  if (state === "waiting" || state === "delayed") return "queued";
  if (state === "failed") return "failed";
  return "queued";
}

function createMemoryJobManager({ ttlMs, cleanupMs, concurrency, logger, handlers, workerEnabled = true }) {
  const jobs = new Map();
  const queue = [];
  const progressSnapshots = new Map();
  let running = 0;

  function nowIso() {
    return new Date().toISOString();
  }

  function cleanupExpiredJobs() {
    const now = Date.now();
    for (const [id, job] of jobs.entries()) {
      if (now > job.expiresAt) {
        jobs.delete(id);
        progressSnapshots.delete(id);
      }
    }
  }

  function setProgress(jobId, event) {
    progressSnapshots.set(jobId, {
      jobId,
      ts: new Date().toISOString(),
      ...event,
    });
  }

  function schedule() {
    while (running < concurrency && queue.length > 0) {
      const job = queue.shift();
      running += 1;
      processJob(job).finally(() => {
        running -= 1;
        setImmediate(schedule);
      });
    }
  }

  async function processJob(job) {
    job.status = "running";
    job.startedAt = nowIso();
    setProgress(job.id, { status: "running", stage: "running", progress: 10 });

    try {
      const handler = handlers[job.type];
      if (!handler) {
        throw new Error(`Unsupported job type: ${job.type}`);
      }

      const out = await handler(job.payload, {
        jobId: job.id,
        reportProgress: (event) => setProgress(job.id, event || {}),
      });
      job.status = "succeeded";
      job.finishedAt = nowIso();
      job.result = out;
      setProgress(job.id, { status: "succeeded", stage: "completed", progress: 100 });
    } catch (error) {
      job.status = "failed";
      job.finishedAt = nowIso();
      job.error = error.message || "Job failed";
      setProgress(job.id, { status: "failed", stage: "failed", progress: 100, error: job.error });
      logger.warn({ jobId: job.id, err: error }, "Background job failed");
    }
  }

  function createJob({ type, meta, payload }) {
    const id = crypto.randomUUID();
    const timestamp = Date.now();
    const job = {
      id,
      type,
      payload,
      meta,
      status: "queued",
      createdAt: nowIso(),
      startedAt: null,
      finishedAt: null,
      error: null,
      result: null,
      expiresAt: timestamp + ttlMs,
    };

    jobs.set(id, job);
    setProgress(id, { status: "queued", stage: "queued", progress: 0 });
    queue.push(job);
    if (workerEnabled) {
      setImmediate(schedule);
    }

    return {
      id: job.id,
      status: job.status,
      createdAt: job.createdAt,
      expiresAt: new Date(job.expiresAt).toISOString(),
    };
  }

  function getJob(id) {
    return jobs.get(id) || null;
  }

  function getJobView(id) {
    const job = getJob(id);
    if (!job) {
      return null;
    }

    return {
      id: job.id,
      type: job.type,
      status: job.status,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      expiresAt: new Date(job.expiresAt).toISOString(),
      error: job.error,
      meta: job.meta,
      downloadReady: job.status === "succeeded",
    };
  }

  function getJobProgress(id) {
    return progressSnapshots.get(id) || null;
  }

  const timer = setInterval(cleanupExpiredJobs, cleanupMs);

  return {
    backend: "memory",
    createJob,
    getJob,
    getJobView,
    getJobProgress,
    async stop() {
      clearInterval(timer);
    },
    stats() {
      let queued = 0;
      let runningCount = 0;
      let succeeded = 0;
      let failed = 0;

      for (const job of jobs.values()) {
        if (job.status === "queued") queued += 1;
        if (job.status === "running") runningCount += 1;
        if (job.status === "succeeded") succeeded += 1;
        if (job.status === "failed") failed += 1;
      }

      return {
        backend: "memory",
        workerEnabled,
        total: jobs.size,
        queued,
        running: runningCount,
        succeeded,
        failed,
        workersBusy: running,
      };
    },
  };
}

function createRedisJobManager({
  redisUrl,
  queueName,
  ttlMs,
  concurrency,
  logger,
  handlers,
  redisConnectTimeoutMs,
  redisWorkerEnabled,
}) {
  const progressSnapshots = new Map();

  function setProgress(jobId, event) {
    progressSnapshots.set(String(jobId), {
      jobId: String(jobId),
      ts: new Date().toISOString(),
      ...event,
    });
  }

  const connection = new IORedis(redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    connectTimeout: redisConnectTimeoutMs,
  });
  const queue = new Queue(queueName, { connection });
  const queueEvents = new QueueEvents(queueName, { connection });
  const worker = redisWorkerEnabled
    ? new Worker(
        queueName,
        async (job) => {
          const payload = job.data || {};
          const handler = handlers[payload.type];
          if (!handler) {
            throw new Error(`Unsupported job type: ${payload.type}`);
          }

          setProgress(job.id, { status: "running", stage: "running", progress: 10 });

          const result = await handler(payload.payload, {
            jobId: String(job.id),
            reportProgress: (event) => setProgress(job.id, event || {}),
          });
          setProgress(job.id, { status: "succeeded", stage: "completed", progress: 100 });
          return {
            outputName: result.outputName,
            contentType: result.contentType || "application/octet-stream",
            storageKey: result.storageKey || null,
            sizeBytes: result.sizeBytes || null,
            stats: result.stats || null,
          };
        },
        {
          connection,
          concurrency,
          removeOnComplete: {
            age: Math.max(1, Math.floor(ttlMs / 1000)),
          },
          removeOnFail: {
            age: Math.max(1, Math.floor(ttlMs / 1000)),
          },
        },
      )
    : null;

  if (worker) {
    worker.on("failed", (job, err) => {
      if (job && job.id) {
        setProgress(job.id, {
          status: "failed",
          stage: "failed",
          progress: 100,
          error: err && err.message ? err.message : "Job failed",
        });
      }
      logger.warn({ jobId: job ? job.id : null, err }, "Redis queue job failed");
    });
  }

  async function createJob({ type, meta, payload }) {
    const job = await queue.add(type, { type, payload, meta }, {
      attempts: 1,
      jobId: crypto.randomUUID(),
    });

    setProgress(job.id, { status: "queued", stage: "queued", progress: 0 });
    return {
      id: String(job.id),
      status: "queued",
      createdAt: toIso(job.timestamp),
      expiresAt: toIso(job.timestamp + ttlMs),
    };
  }

  async function getRawJob(id) {
    const job = await queue.getJob(id);
    return job || null;
  }

  async function getJob(id) {
    const job = await getRawJob(id);
    if (!job) {
      return null;
    }

    const state = await job.getState();
    const result = state === "completed" ? await job.returnvalue : null;
    return {
      id: String(job.id),
      type: job.name,
      status: mapJobState(state),
      createdAt: toIso(job.timestamp),
      startedAt: toIso(job.processedOn),
      finishedAt: toIso(job.finishedOn),
      error: job.failedReason || null,
      meta: (job.data && job.data.meta) || null,
      result,
      expiresAt: toIso(job.timestamp + ttlMs),
    };
  }

  async function getJobView(id) {
    const job = await getJob(id);
    if (!job) {
      return null;
    }

    return {
      id: job.id,
      type: job.type,
      status: job.status,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      expiresAt: job.expiresAt,
      error: job.error,
      meta: job.meta,
      downloadReady: job.status === "succeeded",
    };
  }

  function getJobProgress(id) {
    return progressSnapshots.get(String(id)) || null;
  }

  return {
    backend: "redis",
    createJob,
    getJob,
    getJobView,
    getJobProgress,
    async stop() {
      if (worker) {
        await worker.close();
      }
      await queueEvents.close();
      await queue.close();
      await connection.quit();
    },
    async stats() {
      const [waiting, active, completed, failed] = await Promise.all([
        queue.getWaitingCount(),
        queue.getActiveCount(),
        queue.getCompletedCount(),
        queue.getFailedCount(),
      ]);

      return {
        backend: "redis",
        workerEnabled: Boolean(worker),
        total: waiting + active + completed + failed,
        queued: waiting,
        running: active,
        succeeded: completed,
        failed,
        workersBusy: active,
      };
    },
  };
}

async function createJobManager({
  ttlMs,
  cleanupMs,
  concurrency,
  logger,
  handlers,
  redisUrl,
  queueName,
  redisConnectTimeoutMs,
  redisWorkerEnabled = true,
  allowInMemoryQueueFallback = true,
}) {
  if (!redisUrl) {
    logger.info("Job manager backend: memory");
    return createMemoryJobManager({
      ttlMs,
      cleanupMs,
      concurrency,
      logger,
      handlers,
      workerEnabled: redisWorkerEnabled,
    });
  }

  try {
    const manager = createRedisJobManager({
      redisUrl,
      queueName,
      ttlMs,
      concurrency,
      logger,
      handlers,
      redisConnectTimeoutMs,
      redisWorkerEnabled,
    });

    await manager.stats();
    logger.info({ queueName }, "Job manager backend: redis");
    return manager;
  } catch (error) {
    if (!allowInMemoryQueueFallback) {
      throw error;
    }
    logger.warn({ err: error }, "Redis queue unavailable, falling back to memory backend");
    return createMemoryJobManager({
      ttlMs,
      cleanupMs,
      concurrency,
      logger,
      handlers,
      workerEnabled: redisWorkerEnabled,
    });
  }
}

module.exports = {
  createJobManager,
};
