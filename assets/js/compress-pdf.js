const compressPdfForm = document.getElementById("compressPdfForm");

if (compressPdfForm) {
  const statusEl = document.getElementById("compressPdfStatus");
  const fileEl = document.getElementById("compressPdfFile");
  const presetEl = document.getElementById("preset");
  const qualityEl = document.getElementById("quality");

  ToolspageApi.trackEvent("tool_page_view", { toolName: "Compress PDF" });

  compressPdfForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const file = fileEl.files[0];
    if (!file) {
      ToolspageApi.setStatus(statusEl, "Select a PDF file first.", true);
      return;
    }

    const formData = new FormData();
    formData.append("file", file);
    formData.append("preset", presetEl.value);
    formData.append("quality", qualityEl.value);

    ToolspageApi.trackEvent("upload_started", { toolName: "Compress PDF", fileName: file.name });
    ToolspageApi.setStatus(statusEl, "Preparing compression...", false);

    try {
      const runtime = await ToolspageApi.getRuntimeConfig();
      const fallbackName = file.name.replace(/\.[^.]+$/, "") + "-compressed.pdf";
      let result;
      const thresholdMb = Number(runtime && runtime.asyncThresholdMb);
      const thresholdBytes = Number.isFinite(thresholdMb) && thresholdMb > 0
        ? thresholdMb * 1024 * 1024
        : (8 * 1024 * 1024);

      if (file.size > thresholdBytes) {
        ToolspageApi.setStatus(statusEl, "Large file detected. Queuing background job...", false);
        const job = await ToolspageApi.startAsyncJob({
          endpoint: "/api/v1/jobs/compress-pdf",
          formData,
        });

        await ToolspageApi.waitForJob(job.id, (tick) => {
          ToolspageApi.setStatus(statusEl, `Job ${tick.status}...`, false);
        });

        result = await ToolspageApi.downloadJobResult(job.id, fallbackName);
      } else {
        ToolspageApi.setStatus(statusEl, "Compressing PDF...", false);
        result = await ToolspageApi.submitFileTool({
          endpoint: "/api/v1/tools/compress-pdf",
          formData,
          fallbackName,
        });
      }

      const ratio = result.headers.get("x-compression-ratio") || "n/a";
      const ratioText = ratio === "n/a" ? "" : ` Compression ratio: ${ratio}.`;

      ToolspageApi.renderDownloadResult(
        compressPdfForm,
        `Compression complete.${ratioText}`,
        result.blob,
        result.fileName,
      );

      ToolspageApi.setStatus(statusEl, "Done.", false);
      ToolspageApi.trackEvent("processing_succeeded", {
        toolName: "Compress PDF",
        outputName: result.fileName,
        ratio,
      });
    } catch (error) {
      ToolspageApi.setStatus(statusEl, error.message, true);
      ToolspageApi.trackEvent("processing_failed", {
        toolName: "Compress PDF",
        message: error.message,
      });
    }
  });
}
