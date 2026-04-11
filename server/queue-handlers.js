const { parseQueuedFilePayload } = require("./job-payload");
const { convertPdfToDocx, compressPdf, convertPdfToJpg } = require("./services");
const { compressVideo, videoToMp3, convertAudio, videoToMp3FromUrl, downloadMediaFromUrl } = require("./media");

function createQueueHandlers(outputStore, config, logger = console) {
  function report(ctx, event) {
    if (ctx && typeof ctx.reportProgress === "function") {
      ctx.reportProgress(event);
    }
  }

  return {
    "pdf-to-word": async (payload, ctx) => {
      report(ctx, { status: "running", stage: "converting", progress: 30 });
      const file = parseQueuedFilePayload(payload);
      const options = (payload && payload.options) || {};
      const result = await convertPdfToDocx(file, options, config);
      report(ctx, { status: "running", stage: "storing", progress: 80 });
      const stored = await outputStore.save({
        buffer: result.buffer,
        outputName: result.outputName,
        contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      });
      return stored;
    },
    "compress-pdf": async (payload, ctx) => {
      report(ctx, { status: "running", stage: "compressing", progress: 30 });
      const file = parseQueuedFilePayload(payload);
      const options = (payload && payload.options) || {};
      const result = await compressPdf(file, options, config);
      report(ctx, { status: "running", stage: "storing", progress: 80 });
      const stored = await outputStore.save({
        buffer: result.buffer,
        outputName: result.outputName,
        contentType: "application/pdf",
      });
      return {
        ...stored,
        stats: result.stats || null,
      };
    },
    "pdf-to-jpg": async (payload, ctx) => {
      report(ctx, { status: "running", stage: "rendering-pages", progress: 30 });
      const file = parseQueuedFilePayload(payload);
      const options = (payload && payload.options) || {};
      const result = await convertPdfToJpg(file, options, config);
      report(ctx, { status: "running", stage: "storing", progress: 85 });
      const stored = await outputStore.save({
        buffer: result.buffer,
        outputName: result.outputName,
        contentType: result.contentType,
      });
      return {
        ...stored,
        stats: result.stats || null,
      };
    },
    "video-compress": async (payload, ctx) => {
      report(ctx, { status: "running", stage: "transcoding", progress: 30 });
      const file = parseQueuedFilePayload(payload);
      const options = (payload && payload.options) || {};
      const result = await compressVideo(file, options, config);
      report(ctx, { status: "running", stage: "storing", progress: 80 });
      const stored = await outputStore.save({
        buffer: result.buffer,
        outputName: result.outputName,
        contentType: result.contentType,
      });
      return {
        ...stored,
        stats: result.stats || null,
      };
    },
    "video-to-mp3": async (payload, ctx) => {
      report(ctx, { status: "running", stage: "extracting-audio", progress: 30 });
      const file = parseQueuedFilePayload(payload);
      const options = (payload && payload.options) || {};
      const result = await videoToMp3(file, options, config);
      report(ctx, { status: "running", stage: "storing", progress: 80 });
      const stored = await outputStore.save({
        buffer: result.buffer,
        outputName: result.outputName,
        contentType: result.contentType,
      });
      return {
        ...stored,
        stats: result.stats || null,
      };
    },
    "audio-convert": async (payload, ctx) => {
      report(ctx, { status: "running", stage: "converting-audio", progress: 30 });
      const file = parseQueuedFilePayload(payload);
      const options = (payload && payload.options) || {};
      const result = await convertAudio(file, options, config);
      report(ctx, { status: "running", stage: "storing", progress: 80 });
      const stored = await outputStore.save({
        buffer: result.buffer,
        outputName: result.outputName,
        contentType: result.contentType,
      });
      return {
        ...stored,
        stats: result.stats || null,
      };
    },
    "video-to-mp3-url": async (payload, ctx) => {
      report(ctx, { status: "running", stage: "metadata", progress: 12 });
      const result = await videoToMp3FromUrl(payload, config, {
        logger,
        reportProgress: ctx && typeof ctx.reportProgress === "function"
          ? ctx.reportProgress
          : undefined,
      });
      report(ctx, { status: "running", stage: "storing", progress: 90 });
      const stored = await outputStore.save({
        buffer: result.buffer,
        outputName: result.outputName,
        contentType: result.contentType,
      });
      return {
        ...stored,
        stats: result.stats || null,
      };
    },
    "video-download-url": async (payload, ctx) => {
      report(ctx, { status: "running", stage: "metadata", progress: 12 });
      const result = await downloadMediaFromUrl(payload, config, {
        logger,
        reportProgress: ctx && typeof ctx.reportProgress === "function"
          ? ctx.reportProgress
          : undefined,
      });
      report(ctx, { status: "running", stage: "storing", progress: 90 });
      const stored = await outputStore.save({
        buffer: result.buffer,
        outputName: result.outputName,
        contentType: result.contentType,
      });
      return {
        ...stored,
        stats: result.stats || null,
      };
    },
  };
}

module.exports = {
  createQueueHandlers,
};
