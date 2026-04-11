const videoCompressForm = document.getElementById("videoCompressForm");

if (videoCompressForm) {
  const statusEl = document.getElementById("videoCompressStatus");
  const fileEl = document.getElementById("videoCompressFile");
  const qualityEl = document.getElementById("videoQuality");
  const bitrateEl = document.getElementById("videoBitrate");

  ToolspageApi.trackEvent("tool_page_view", { toolName: "Video Compress" });

  videoCompressForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const file = fileEl.files[0];
    if (!file) {
      ToolspageApi.setStatus(statusEl, "Select a video file first.", true);
      return;
    }



    const formData = new FormData();
    formData.append("file", file);
    formData.append("quality", qualityEl.value);
    formData.append("bitrateKbps", bitrateEl.value);
    formData.append("rightsConfirmed", "true");

    ToolspageApi.setStatus(statusEl, "Preparing compression...", false);

    try {
      const runtime = await ToolspageApi.getRuntimeConfig();
      const fallbackName = file.name.replace(/\.[^.]+$/, "") + "-compressed.mp4";
      let result;
      const thresholdMb = Number(runtime && runtime.asyncThresholdMb);
      const thresholdBytes = Number.isFinite(thresholdMb) && thresholdMb > 0
        ? thresholdMb * 1024 * 1024
        : (8 * 1024 * 1024);

      if (file.size > thresholdBytes) {
        ToolspageApi.setStatus(statusEl, "Large file detected. Queuing background job...", false);
        const job = await ToolspageApi.startAsyncJob({
          endpoint: "/api/v1/jobs/video-compress",
          formData,
        });

        await ToolspageApi.waitForJob(job.id, (tick) => {
          if (tick.status === "running" && tick.progress > 0 && tick.progress <= 100) {
            ToolspageApi.setStatus(statusEl, `Processing video... ${tick.progress}%`, false);
          } else {
            ToolspageApi.setStatus(statusEl, `Job ${tick.status}...`, false);
          }
        });

        result = await ToolspageApi.downloadJobResult(job.id, fallbackName);
      } else {
        ToolspageApi.setStatus(statusEl, "Compressing video...", false);
        result = await ToolspageApi.submitFileTool({
          endpoint: "/api/v1/tools/video-compress",
          formData,
          fallbackName,
        });
      }

      const ratio = result.headers.get("x-compression-ratio") || "n/a";
      ToolspageApi.renderDownloadResult(
        videoCompressForm,
        `Compression complete.${ratio !== "n/a" ? ` Ratio: ${ratio}.` : ""}`,
        result.blob,
        result.fileName,
      );
      ToolspageApi.setStatus(statusEl, "Done.", false);
    } catch (error) {
      ToolspageApi.setStatus(statusEl, error.message, true);
    }
  });
}
