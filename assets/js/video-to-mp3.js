const videoToMp3Form = document.getElementById("videoToMp3Form");

if (videoToMp3Form) {
  const statusEl = document.getElementById("videoToMp3Status");
  const fileEl = document.getElementById("videoToMp3File");
  const urlEl = document.getElementById("videoSourceUrl");
  const qualityEl = document.getElementById("urlAudioQuality");
  const bitrateEl = document.getElementById("audioBitrate");
  const metaTitleEl = document.getElementById("metaTitle");
  const metaArtistEl = document.getElementById("metaArtist");
  const runtimeUi = ToolspageApi.createToolRuntime({
    form: videoToMp3Form,
    statusEl,
  });

  ToolspageApi.trackEvent("tool_page_view", { toolName: "Video to MP3" });

  videoToMp3Form.addEventListener("submit", async (event) => {
    event.preventDefault();



    const file = fileEl.files[0];
    const sourceUrl = String(urlEl.value || "").trim();
    if (!file && !sourceUrl) {
      runtimeUi.setStatus("Provide a video file or source URL.", true);
      return;
    }

    if (file && sourceUrl) {
      runtimeUi.setStatus("Choose either upload or URL mode, not both.", true);
      return;
    }

    try {
      runtimeUi.setBusy(true, "Processing...");
      const runtime = await ToolspageApi.getRuntimeConfig();

      if (!file && sourceUrl) {
        if (!runtime.media || !runtime.media.urlIngestEnabled) {
          runtimeUi.setStatus("URL mode is disabled on this server.", true);
          return;
        }

        runtimeUi.setStatus("Queuing URL extraction job...", false);
        const flow = await ToolspageApi.runJobFlow({
          startJob: () => ToolspageApi.startJsonJob({
            endpoint: "/api/v1/jobs/video-to-mp3-url",
            payload: {
              sourceUrl,
              rightsConfirmed: true,
              bitrateKbps: bitrateEl.value,
              quality: qualityEl ? qualityEl.value : "medium",
              metaTitle: metaTitleEl ? metaTitleEl.value : "",
              metaArtist: metaArtistEl ? metaArtistEl.value : "",
            },
          }),
          fallbackName: "source-audio.mp3",
          runtimeUi,
          onTick: (tick) => {
            if (tick.status === "running" && tick.progress > 0 && tick.progress <= 100) {
              runtimeUi.setStatus(`Downloading and extracting... ${tick.progress}%`, false);
            } else {
              runtimeUi.setStatus(`Job ${tick.status}...`, false);
            }
          },
        });
        const result = flow.result;
        runtimeUi.renderResult(
          "Extraction complete. Download your MP3.",
          result.blob,
          result.fileName,
        );
        runtimeUi.setStatus("Done. File is ready to download.", false);
        return;
      }

      const formData = new FormData();
      formData.append("file", file);
      formData.append("bitrateKbps", bitrateEl.value);
      formData.append("rightsConfirmed", "true");
      if (metaTitleEl && metaTitleEl.value) formData.append("metaTitle", metaTitleEl.value);
      if (metaArtistEl && metaArtistEl.value) formData.append("metaArtist", metaArtistEl.value);
      const fallbackName = file.name.replace(/\.[^.]+$/, "") + ".mp3";

      const result = await ToolspageApi.submitWithAutoAsync({
        runtimeConfig: runtime,
        fileSizeBytes: file.size,
        formData,
        fallbackName,
        syncEndpoint: "/api/v1/tools/video-to-mp3",
        asyncEndpoint: "/api/v1/jobs/video-to-mp3",
        runtimeUi,
        asyncLabel: "Large file detected. Queuing background job...",
        syncLabel: "Extracting audio...",
        onTick: (tick) => {
          if (tick.status === "running" && tick.progress > 0 && tick.progress <= 100) {
            runtimeUi.setStatus(`Extracting audio... ${tick.progress}%`, false);
          } else {
            runtimeUi.setStatus(`Job ${tick.status}...`, false);
          }
        },
      });

      runtimeUi.renderResult(
        "Extraction complete. Download your MP3.",
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
