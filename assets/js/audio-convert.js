const audioConvertForm = document.getElementById("audioConvertForm");

if (audioConvertForm) {
  const statusEl = document.getElementById("audioConvertStatus");
  const fileEl = document.getElementById("audioConvertFile");
  const formatEl = document.getElementById("targetFormat");
  const bitrateEl = document.getElementById("audioBitrate");
  const metaTitleEl = document.getElementById("metaTitle");
  const metaArtistEl = document.getElementById("metaArtist");
  const runtimeUi = ToolspageApi.createToolRuntime({
    form: audioConvertForm,
    statusEl,
  });

  ToolspageApi.trackEvent("tool_page_view", { toolName: "Audio Convert" });

  audioConvertForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const file = fileEl.files[0];
    if (!file) {
      runtimeUi.setStatus("Select an audio file first.", true);
      return;
    }



    const formData = new FormData();
    formData.append("file", file);
    formData.append("targetFormat", formatEl.value);
    formData.append("bitrateKbps", bitrateEl ? bitrateEl.value : "192");
    formData.append("rightsConfirmed", "true");
    if (metaTitleEl && metaTitleEl.value) formData.append("metaTitle", metaTitleEl.value);
    if (metaArtistEl && metaArtistEl.value) formData.append("metaArtist", metaArtistEl.value);

    runtimeUi.setBusy(true, "Converting...");
    runtimeUi.setStatus("Preparing conversion...", false);

    try {
      const runtime = await ToolspageApi.getRuntimeConfig();
      const fallbackName = file.name.replace(/\.[^.]+$/, "") + `.${formatEl.value}`;
      const result = await ToolspageApi.submitWithAutoAsync({
        runtimeConfig: runtime,
        fileSizeBytes: file.size,
        formData,
        fallbackName,
        syncEndpoint: "/api/v1/tools/audio-convert",
        asyncEndpoint: "/api/v1/jobs/audio-convert",
        runtimeUi,
        asyncLabel: "Large file detected. Queuing background job...",
        syncLabel: "Converting audio...",
        onTick: (tick) => {
          if (tick.status === "running" && tick.progress > 0 && tick.progress <= 100) {
            runtimeUi.setStatus(`Converting audio... ${tick.progress}%`, false);
          } else {
            runtimeUi.setStatus(`Job ${tick.status}...`, false);
          }
        },
      });

      runtimeUi.renderResult(
        "Conversion complete. Download your file.",
        result.blob,
        result.fileName,
      );
      runtimeUi.setStatus("Done. File is ready to download.", false);
    } catch (error) {
      runtimeUi.setStatus(error.message, true);
    } finally {
      runtimeUi.setBusy(false);
    }
  });
}
