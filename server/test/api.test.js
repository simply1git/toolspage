const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const request = require("supertest");

const { createApp } = require("../index");
const { compressVideo } = require("../media");
const { __internal } = require("../media");
const { VideoDownloadManager, URLValidator } = require("../video-download");
const { createOutputStore } = require("../output-store");

function clearServerModuleCache() {
  delete require.cache[require.resolve("../config")];
  delete require.cache[require.resolve("../media")];
  delete require.cache[require.resolve("../middlewares")];
  delete require.cache[require.resolve("../index")];
}

async function createFreshApp() {
  clearServerModuleCache();
  const { createApp: freshCreateApp } = require("../index");
  return freshCreateApp();
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForTerminalJob(app, jobId, maxAttempts = 20, pauseMs = 50) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const response = await request(app)
      .get(`/api/v1/jobs/${jobId}`)
      .expect(200);

    const status = response.body && response.body.job && response.body.job.status;
    if (status === "succeeded" || status === "failed") {
      return response.body.job;
    }

    await delay(pauseMs);
  }

  const err = new Error("Job did not reach terminal state in time");
  err.status = 408;
  throw err;
}

test("status endpoint returns UP", async () => {
  const { app, shutdown } = await createApp();
  const response = await request(app).get("/api/v1/info/status").expect(200);

  assert.equal(response.body.ok, true);
  assert.equal(response.body.status, "UP");
  assert.equal(typeof response.body.uptimeSec, "number");
  assert.equal(typeof response.body.jobs.total, "number");

  await shutdown();
});

test("metrics endpoint emits prometheus payload", async () => {
  const { app, shutdown } = await createApp();
  const response = await request(app).get("/api/v1/metrics").expect(200);

  assert.match(response.text, /toolspage_uptime_seconds/);
  assert.match(response.text, /toolspage_jobs_total/);

  await shutdown();
});

test("unknown api route returns 404 JSON", async () => {
  const { app, shutdown } = await createApp();
  const response = await request(app).get("/api/v1/does-not-exist").expect(404);

  assert.equal(response.body.ok, false);
  assert.equal(response.body.error, "Not found");

  await shutdown();
});

test("video-to-mp3 requires rights confirmation", async () => {
  const originalRequireRights = process.env.MEDIA_REQUIRE_RIGHTS_CONFIRMATION;
  try {
    process.env.MEDIA_REQUIRE_RIGHTS_CONFIRMATION = "true";
    const { app, shutdown } = await createFreshApp();
    try {
      const response = await request(app)
        .post("/api/v1/tools/video-to-mp3")
        .attach("file", Buffer.from("fake-video"), {
          filename: "sample.mp4",
          contentType: "video/mp4",
        })
        .field("rightsConfirmed", "false")
        .expect(400);

      assert.equal(response.body.ok, false);
      assert.match(response.body.error, /rights/i);
    } finally {
      await shutdown();
    }
  } finally {
    if (originalRequireRights === undefined) delete process.env.MEDIA_REQUIRE_RIGHTS_CONFIRMATION;
    else process.env.MEDIA_REQUIRE_RIGHTS_CONFIRMATION = originalRequireRights;
    clearServerModuleCache();
  }
});

test("video-to-mp3-url accepts YouTube URLs when enabled", async () => {
  const original = process.env.MEDIA_URL_INGEST_ENABLED;
  const originalRunWorker = process.env.RUN_QUEUE_WORKER_IN_API;

  try {
    process.env.MEDIA_URL_INGEST_ENABLED = "true";
    process.env.RUN_QUEUE_WORKER_IN_API = "false";

    const { app, shutdown } = await createFreshApp();

    try {
      const response = await request(app)
        .post("/api/v1/jobs/video-to-mp3-url")
        .send({
          sourceUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
          rightsConfirmed: true,
          bitrateKbps: "192",
          quality: "high",
        })
        .expect(202);

      assert.equal(response.body.ok, true);
      assert.ok(response.body.job && response.body.job.id);
    } finally {
      await shutdown();
    }
  } finally {
    process.env.MEDIA_URL_INGEST_ENABLED = original;
    if (originalRunWorker === undefined) delete process.env.RUN_QUEUE_WORKER_IN_API;
    else process.env.RUN_QUEUE_WORKER_IN_API = originalRunWorker;
    clearServerModuleCache();
  }
});

test("video-download-url accepts queued video mode when enabled", async () => {
  const originalEnabled = process.env.MEDIA_URL_INGEST_ENABLED;
  const originalRunWorker = process.env.RUN_QUEUE_WORKER_IN_API;

  try {
    process.env.MEDIA_URL_INGEST_ENABLED = "true";
    process.env.RUN_QUEUE_WORKER_IN_API = "false";

    const { app, shutdown } = await createFreshApp();

    try {
      const response = await request(app)
        .post("/api/v1/jobs/video-download-url")
        .send({
          sourceUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
          rightsConfirmed: true,
          mode: "video",
          qualityProfile: "720p",
          videoFormat: "mp4",
          allowPlaylist: false,
        })
        .expect(202);

      assert.equal(response.body.ok, true);
      assert.ok(response.body.job && response.body.job.id);
    } finally {
      await shutdown();
    }
  } finally {
    if (originalEnabled === undefined) delete process.env.MEDIA_URL_INGEST_ENABLED;
    else process.env.MEDIA_URL_INGEST_ENABLED = originalEnabled;
    if (originalRunWorker === undefined) delete process.env.RUN_QUEUE_WORKER_IN_API;
    else process.env.RUN_QUEUE_WORKER_IN_API = originalRunWorker;
    clearServerModuleCache();
  }
});

test("video-download-inspect returns disabled when URL ingestion is off", async () => {
  const originalEnabled = process.env.MEDIA_URL_INGEST_ENABLED;

  try {
    process.env.MEDIA_URL_INGEST_ENABLED = "false";
    const { app, shutdown } = await createFreshApp();

    try {
      const response = await request(app)
        .post("/api/v1/jobs/video-download-inspect")
        .send({
          sourceUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
          rightsConfirmed: true,
        })
        .expect(403);

      assert.equal(response.body.ok, false);
      assert.match(String(response.body.error || ""), /disabled/i);
    } finally {
      await shutdown();
    }
  } finally {
    if (originalEnabled === undefined) delete process.env.MEDIA_URL_INGEST_ENABLED;
    else process.env.MEDIA_URL_INGEST_ENABLED = originalEnabled;
    clearServerModuleCache();
  }
});

test("video-download-url rejects invalid mode at submit time", async () => {
  const originalEnabled = process.env.MEDIA_URL_INGEST_ENABLED;

  try {
    process.env.MEDIA_URL_INGEST_ENABLED = "true";
    const { app, shutdown } = await createFreshApp();

    try {
      const response = await request(app)
        .post("/api/v1/jobs/video-download-url")
        .send({
          sourceUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
          rightsConfirmed: true,
          mode: "invalid-mode",
        })
        .expect(400);

      assert.equal(response.body.ok, false);
      assert.match(String(response.body.error || ""), /invalid mode/i);
    } finally {
      await shutdown();
    }
  } finally {
    if (originalEnabled === undefined) delete process.env.MEDIA_URL_INGEST_ENABLED;
    else process.env.MEDIA_URL_INGEST_ENABLED = originalEnabled;
    clearServerModuleCache();
  }
});

test("video-download-url job records progress snapshot lifecycle", async () => {
  const originalEnabled = process.env.MEDIA_URL_INGEST_ENABLED;
  const originalRunWorker = process.env.RUN_QUEUE_WORKER_IN_API;

  try {
    process.env.MEDIA_URL_INGEST_ENABLED = "true";
    process.env.RUN_QUEUE_WORKER_IN_API = "false";

    const { app, shutdown } = await createFreshApp();

    try {
      const response = await request(app)
        .post("/api/v1/jobs/video-download-url")
        .send({
          sourceUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
          rightsConfirmed: true,
          mode: "video",
          qualityProfile: "720p",
          videoFormat: "mp4",
        })
        .expect(202);

      const jobId = response.body.job && response.body.job.id;
      assert.ok(jobId);

      const progressResponse = await request(app)
        .get(`/api/v1/jobs/${jobId}`)
        .expect(200);

      assert.equal(progressResponse.body.ok, true);
      assert.equal(progressResponse.body.job.status, "queued");
    } finally {
      await shutdown();
    }
  } finally {
    if (originalEnabled === undefined) delete process.env.MEDIA_URL_INGEST_ENABLED;
    else process.env.MEDIA_URL_INGEST_ENABLED = originalEnabled;
    if (originalRunWorker === undefined) delete process.env.RUN_QUEUE_WORKER_IN_API;
    else process.env.RUN_QUEUE_WORKER_IN_API = originalRunWorker;
    clearServerModuleCache();
  }
});

test("video-download-inspect validates source URL format", async () => {
  const originalEnabled = process.env.MEDIA_URL_INGEST_ENABLED;

  try {
    process.env.MEDIA_URL_INGEST_ENABLED = "true";
    const { app, shutdown } = await createFreshApp();

    try {
      const response = await request(app)
        .post("/api/v1/jobs/video-download-inspect")
        .send({
          sourceUrl: "notaurl",
          rightsConfirmed: true,
        })
        .expect(400);

      assert.equal(response.body.ok, false);
      assert.match(String(response.body.error || ""), /invalid/i);
    } finally {
      await shutdown();
    }
  } finally {
    if (originalEnabled === undefined) delete process.env.MEDIA_URL_INGEST_ENABLED;
    else process.env.MEDIA_URL_INGEST_ENABLED = originalEnabled;
    clearServerModuleCache();
  }
});

test("video-to-mp3-url rejects non-allowlisted URL", async () => {
  const originalEnabled = process.env.MEDIA_URL_INGEST_ENABLED;
  const originalAllowlist = process.env.MEDIA_URL_ALLOWLIST;
  const originalRunWorker = process.env.RUN_QUEUE_WORKER_IN_API;

  try {
    process.env.MEDIA_URL_INGEST_ENABLED = "true";
    process.env.MEDIA_URL_ALLOWLIST = "youtube.com";
    process.env.RUN_QUEUE_WORKER_IN_API = "true";

    const { app, shutdown } = await createFreshApp();

    try {
      const submit = await request(app)
        .post("/api/v1/jobs/video-to-mp3-url")
        .send({
          sourceUrl: "https://example.com/video.mp4",
          rightsConfirmed: true,
          bitrateKbps: "192",
        })
        .expect(202);

      assert.equal(submit.body.ok, true);
      const jobId = submit.body.job && submit.body.job.id;
      assert.ok(jobId);

      const terminal = await waitForTerminalJob(app, jobId);
      assert.equal(terminal.status, "failed");
      assert.match(String(terminal.error || ""), /allowlist/i);
    } finally {
      await shutdown();
    }
  } finally {
    if (originalEnabled === undefined) delete process.env.MEDIA_URL_INGEST_ENABLED;
    else process.env.MEDIA_URL_INGEST_ENABLED = originalEnabled;
    if (originalAllowlist === undefined) delete process.env.MEDIA_URL_ALLOWLIST;
    else process.env.MEDIA_URL_ALLOWLIST = originalAllowlist;
    if (originalRunWorker === undefined) delete process.env.RUN_QUEUE_WORKER_IN_API;
    else process.env.RUN_QUEUE_WORKER_IN_API = originalRunWorker;
    clearServerModuleCache();
  }
});

test("video-to-mp3-url accepts allowlisted platform URL", async () => {
  const originalEnabled = process.env.MEDIA_URL_INGEST_ENABLED;
  const originalAllowlist = process.env.MEDIA_URL_ALLOWLIST;
  const originalRunWorker = process.env.RUN_QUEUE_WORKER_IN_API;

  try {
    process.env.MEDIA_URL_INGEST_ENABLED = "true";
    process.env.MEDIA_URL_ALLOWLIST = "youtube.com";
    process.env.RUN_QUEUE_WORKER_IN_API = "false";

    const { app, shutdown } = await createFreshApp();

    try {
      const response = await request(app)
        .post("/api/v1/jobs/video-to-mp3-url")
        .send({
          sourceUrl: "https://youtu.be/dQw4w9WgXcQ",
          rightsConfirmed: true,
          bitrateKbps: "192",
          quality: "medium",
        })
        .expect(202);

      assert.equal(response.body.ok, true);
      assert.ok(response.body.job && response.body.job.id);
    } finally {
      await shutdown();
    }
  } finally {
    if (originalEnabled === undefined) delete process.env.MEDIA_URL_INGEST_ENABLED;
    else process.env.MEDIA_URL_INGEST_ENABLED = originalEnabled;
    if (originalAllowlist === undefined) delete process.env.MEDIA_URL_ALLOWLIST;
    else process.env.MEDIA_URL_ALLOWLIST = originalAllowlist;
    if (originalRunWorker === undefined) delete process.env.RUN_QUEUE_WORKER_IN_API;
    else process.env.RUN_QUEUE_WORKER_IN_API = originalRunWorker;
    clearServerModuleCache();
  }
});

test("audio-convert rejects unsupported target format", async () => {
  const { app, shutdown } = await createApp();
  const response = await request(app)
    .post("/api/v1/tools/audio-convert")
    .attach("file", Buffer.from("fake-audio"), {
      filename: "sample.mp3",
      contentType: "audio/mpeg",
    })
    .field("rightsConfirmed", "true")
    .field("targetFormat", "flac")
    .expect(400);

  assert.equal(response.body.ok, false);
  assert.match(response.body.error, /unsupported output format/i);

  await shutdown();
});

test("video-compress enforces media upload limit", async () => {
  const overLimitBuffer = Buffer.alloc(2 * 1024 * 1024, 1);
  const file = {
    originalname: "large.mp4",
    mimetype: "video/mp4",
    buffer: overLimitBuffer,
  };

  await assert.rejects(
    () => compressVideo(file, { rightsConfirmed: true }, {
      mediaRequireRightsConfirmation: true,
      mediaUploadLimitBytes: 1 * 1024 * 1024,
      mediaUploadLimitMb: 1,
      mediaVideoExtensions: [".mp4"],
      enableClamScan: false,
      ffprobeCommand: "ffprobe",
      ffprobeTimeoutMs: 20000,
      ffmpegCommand: "ffmpeg",
      ffmpegTimeoutMs: 180000,
      mediaMaxDurationSec: 1800,
    }),
    (error) => error && error.status === 413,
  );
});

test("media command runner returns ETIMEDOUT for long-running process", async () => {
  await assert.rejects(
    () => __internal.spawnWithTimeout("ping", ["127.0.0.1", "-n", "6"], 50),
    (error) => error && error.code === "ETIMEDOUT",
  );
});

test("video-to-mp3 async submit returns 429 when media queue is saturated", async () => {
  const original = {
    MEDIA_QUEUE_MAX_PENDING: process.env.MEDIA_QUEUE_MAX_PENDING,
    MEDIA_JOB_CONCURRENCY: process.env.MEDIA_JOB_CONCURRENCY,
    RUN_QUEUE_WORKER_IN_API: process.env.RUN_QUEUE_WORKER_IN_API,
  };

  try {
    process.env.MEDIA_QUEUE_MAX_PENDING = "1";
    process.env.MEDIA_JOB_CONCURRENCY = "1";
    process.env.RUN_QUEUE_WORKER_IN_API = "false";

    const { app, shutdown } = await createFreshApp();

    try {
      const submit = () => request(app)
        .post("/api/v1/jobs/video-to-mp3")
        .attach("file", Buffer.from("fake-video"), {
          filename: "sample.mp4",
          contentType: "video/mp4",
        })
        .field("rightsConfirmed", "true");

      const [first, second] = await Promise.all([submit(), submit()]);
      const statuses = [first.status, second.status].sort((a, b) => a - b);
      assert.deepEqual(statuses, [202, 429]);

      const saturated = first.status === 429 ? first : second;
      assert.equal(saturated.body.ok, false);
      assert.equal(saturated.body.queue, "media");
      assert.match(saturated.body.error, /saturated/i);
    } finally {
      await shutdown();
    }
  } finally {
    if (original.MEDIA_QUEUE_MAX_PENDING === undefined) delete process.env.MEDIA_QUEUE_MAX_PENDING;
    else process.env.MEDIA_QUEUE_MAX_PENDING = original.MEDIA_QUEUE_MAX_PENDING;
    if (original.MEDIA_JOB_CONCURRENCY === undefined) delete process.env.MEDIA_JOB_CONCURRENCY;
    else process.env.MEDIA_JOB_CONCURRENCY = original.MEDIA_JOB_CONCURRENCY;
    if (original.RUN_QUEUE_WORKER_IN_API === undefined) delete process.env.RUN_QUEUE_WORKER_IN_API;
    else process.env.RUN_QUEUE_WORKER_IN_API = original.RUN_QUEUE_WORKER_IN_API;

    clearServerModuleCache();
  }
});
test("video-download-url accepts canonical quality profiles (including 4k and 1440p tiers)", async () => {
  const originalEnabled = process.env.MEDIA_URL_INGEST_ENABLED;
  const originalRunWorker = process.env.RUN_QUEUE_WORKER_IN_API;

  try {
    process.env.MEDIA_URL_INGEST_ENABLED = "true";
    process.env.RUN_QUEUE_WORKER_IN_API = "false";

    const { app, shutdown } = await createFreshApp();

    try {
      for (const profile of ["4k60", "4k", "1440p60", "1440p", "1080p60", "1080p", "720p60", "720p", "480p", "audio-high", "audio-medium", "audio-low"]) {
        const response = await request(app)
          .post("/api/v1/jobs/video-download-url")
          .send({
            sourceUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            rightsConfirmed: true,
            mode: profile.startsWith("audio") ? "audio" : "video",
            qualityProfile: profile,
            videoFormat: "mp4",
          })
          .expect(202);

        assert.ok(response.body.job && response.body.job.id, `Failed for profile ${profile}`);
      }
    } finally {
      await shutdown();
    }
  } finally {
    if (originalEnabled === undefined) delete process.env.MEDIA_URL_INGEST_ENABLED;
    else process.env.MEDIA_URL_INGEST_ENABLED = originalEnabled;
    if (originalRunWorker === undefined) delete process.env.RUN_QUEUE_WORKER_IN_API;
    else process.env.RUN_QUEUE_WORKER_IN_API = originalRunWorker;
    clearServerModuleCache();
  }
});
test("video downloader reports fine-grained progress from yt-dlp progress events", async () => {
  const manager = new VideoDownloadManager({
    ytdlpTimeoutMs: 10000,
    mediaUploadLimitBytes: 10 * 1024 * 1024,
  }, {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  });

  manager.ytdlp = {
    exec(args) {
      const emitter = new EventEmitter();
      const outputTemplate = args[args.indexOf("-o") + 1];
      const outputDir = path.dirname(outputTemplate);

      process.nextTick(async () => {
        await fs.mkdir(outputDir, { recursive: true });
        await fs.writeFile(path.join(outputDir, "sample.mp3"), Buffer.from("fake-mp3-data"));
        emitter.emit("progress", {
          percent: 10,
          currentSpeed: "1.0MiB/s",
          eta: "00:10",
          totalSize: "20MiB",
        });
        emitter.emit("close", 0);
      });

      return emitter;
    },
  };

  const snapshots = [];
  const result = await manager.executeDownload("https://youtu.be/dQw4w9WgXcQ", {
    outputFormat: "audio",
    quality: "medium",
    targetAudioFormat: "mp3",
  }, {
    reportProgress: (event) => snapshots.push(event),
  });

  assert.equal(result.contentType, "audio/mpeg");
  assert.ok(snapshots.length > 0);

  const progressEvent = snapshots.find((entry) => entry.downloadPercent === 10);
  assert.ok(progressEvent);
  assert.equal(progressEvent.stage, "extracting-audio");
  assert.equal(progressEvent.speed, "1.0MiB/s");
  assert.equal(progressEvent.eta, "00:10");
  assert.equal(progressEvent.totalSize, "20MiB");
  assert.ok(progressEvent.progress >= 25 && progressEvent.progress <= 80);
});

test("video downloader parses percent from yt-dlp text events", async () => {
  const manager = new VideoDownloadManager({
    ytdlpTimeoutMs: 10000,
    mediaUploadLimitBytes: 10 * 1024 * 1024,
  }, {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  });

  manager.ytdlp = {
    exec(args) {
      const emitter = new EventEmitter();
      const outputTemplate = args[args.indexOf("-o") + 1];
      const outputDir = path.dirname(outputTemplate);

      process.nextTick(async () => {
        await fs.mkdir(outputDir, { recursive: true });
        await fs.writeFile(path.join(outputDir, "sample.mp4"), Buffer.from("fake-video-data"));
        emitter.emit("ytDlpEvent", "download", "[download] 42.5% of 20.00MiB at 1.00MiB/s ETA 00:03");
        emitter.emit("close", 0);
      });

      return emitter;
    },
  };

  const snapshots = [];
  const result = await manager.executeDownload("https://www.youtube.com/watch?v=dQw4w9WgXcQ", {
    outputFormat: "video",
    qualityProfile: "720p",
    targetVideoFormat: "mp4",
  }, {
    reportProgress: (event) => snapshots.push(event),
  });

  assert.equal(result.contentType, "video/mp4");
  assert.ok(snapshots.length > 0);

  const parsedEvent = snapshots.find((entry) => entry.downloadPercent === 42.5);
  assert.ok(parsedEvent);
  assert.equal(parsedEvent.stage, "downloading");
  assert.ok(parsedEvent.progress >= 25 && parsedEvent.progress <= 80);
});

test("URLValidator detects Pinterest URLs", () => {
  const platform = URLValidator.detectPlatform("https://www.pinterest.com/pin/123456789/");
  assert.equal(platform, "pinterest");
});

test("URLValidator blocks localhost-resolving URLs", async () => {
  await assert.rejects(
    () => URLValidator.validateUrlResolved("http://localhost/resource"),
    (error) => error && error.status === 403,
  );
});

test("output store signs and verifies download links", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "toolspage-output-store-"));
  const auditPath = path.join(tmpDir, "audit.log");

  try {
    const store = createOutputStore({
      storageProvider: "local",
      outputLocalDir: tmpDir,
      outputPublicBaseUrl: "http://localhost:8080",
      signedUrlTtlSec: 60,
      outputRetentionSec: 3600,
      outputAuditLogPath: auditPath,
      outputSigningSecret: "test-signing-secret-1234567890",
    }, { info: () => {} });

    const saved = await store.save({
      buffer: Buffer.from("hello"),
      outputName: "hello.txt",
      contentType: "text/plain",
    });

    const signedUrl = await store.getDownloadUrl(saved.storageKey);
    const parsed = new URL(signedUrl);
    const verified = store.verifySignedDownload(saved.storageKey, {
      expires: parsed.searchParams.get("expires"),
      sig: parsed.searchParams.get("sig"),
    });
    assert.equal(verified, true);

    const rejected = store.verifySignedDownload(saved.storageKey, {
      expires: parsed.searchParams.get("expires"),
      sig: "bad-signature",
    });
    assert.equal(rejected, false);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});
