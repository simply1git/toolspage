const pdfToWordForm = document.getElementById("pdfToWordForm");

if (pdfToWordForm) {
  const statusEl = document.getElementById("pdfToWordStatus");
  const fileEl = document.getElementById("pdfToWordFile");
  const ocrModeEl = document.getElementById("ocrMode");
  const languageEl = document.getElementById("language");

  ToolspageApi.trackEvent("tool_page_view", { toolName: "PDF to Word" });

  pdfToWordForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const file = fileEl.files[0];
    if (!file) {
      ToolspageApi.setStatus(statusEl, "Select a PDF file first.", true);
      return;
    }

    const formData = new FormData();
    formData.append("file", file);
    formData.append("ocrMode", ocrModeEl.value);
    formData.append("language", languageEl.value);

    ToolspageApi.trackEvent("upload_started", { toolName: "PDF to Word", fileName: file.name });
    ToolspageApi.setStatus(statusEl, "Preparing conversion...", false);

    try {
      const runtime = await ToolspageApi.getRuntimeConfig();
      const fallbackName = file.name.replace(/\.[^.]+$/, "") + ".docx";
      let result;

      if (file.size > runtime.asyncThresholdMb * 1024 * 1024) {
        ToolspageApi.setStatus(statusEl, "Large file detected. Queuing background job...", false);
        const job = await ToolspageApi.startAsyncJob({
          endpoint: "/api/v1/jobs/pdf-to-word",
          formData,
        });

        await ToolspageApi.waitForJob(job.id, (tick) => {
          ToolspageApi.setStatus(statusEl, `Job ${tick.status}...`, false);
        });

        result = await ToolspageApi.downloadJobResult(job.id, fallbackName);
      } else {
        ToolspageApi.setStatus(statusEl, "Converting PDF to DOCX...", false);
        result = await ToolspageApi.submitFileTool({
          endpoint: "/api/v1/tools/pdf-to-word",
          formData,
          fallbackName,
        });
      }

      ToolspageApi.renderDownloadResult(
        pdfToWordForm,
        "Conversion complete. Download your DOCX file.",
        result.blob,
        result.fileName,
      );

      ToolspageApi.setStatus(statusEl, "Done.", false);
      ToolspageApi.trackEvent("processing_succeeded", {
        toolName: "PDF to Word",
        outputName: result.fileName,
      });
    } catch (error) {
      ToolspageApi.setStatus(statusEl, error.message, true);
      ToolspageApi.trackEvent("processing_failed", {
        toolName: "PDF to Word",
        message: error.message,
      });
    }
  });
}
