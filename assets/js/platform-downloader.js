const form = document.getElementById("platformDownloaderForm");

if (form) {
  const sourceUrlEl = document.getElementById("platformSourceUrl");
  const modeEl = document.getElementById("platformMode");
  const qualityEl = document.getElementById("platformQuality");
  const videoFormatEl = document.getElementById("platformVideoFormat");
  const audioFormatEl = document.getElementById("platformAudioFormat");
  const statusEl = document.getElementById("platformStatus");
  const progressStageEl = document.getElementById("platformProgressStage");
  const progressPercentEl = document.getElementById("platformProgressPercent");
  const progressFillEl = document.getElementById("platformProgressFill");
  const progressTrackEl = document.getElementById("platformProgressTrack");
  const platformHintEl = document.getElementById("platformHint");
  const expectedPlatform = String(form.dataset.platform || "").toLowerCase();
  const toolName = String(form.dataset.toolName || "Platform Downloader");
  const runtimeUi = ToolspageApi.createToolRuntime({
    form,
    statusEl,
    progress: {
      stageEl: progressStageEl,
      percentEl: progressPercentEl,
      fillEl: progressFillEl,
      trackEl: progressTrackEl,
    },
  });

  function normalizeSourceUrl(input) {
    const cleaned = String(input || "")
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .trim();
    try {
      const parsed = new URL(cleaned);
      if (/youtu\.be$/i.test(parsed.hostname)) {
        parsed.searchParams.delete("si");
      }
      return parsed.toString();
    } catch (_err) {
      return cleaned;
    }
  }

  function isAudioProfile(profile) {
    return String(profile || "").startsWith("audio-");
  }

  function modeFromQuality(profile) {
    return isAudioProfile(profile) ? "audio" : "video";
  }

  function makeInspectHeaders(runtime) {
    const headers = {
      "content-type": "application/json",
    };

    if (runtime && runtime.apiKeyRequired && window.TOOLSPAGE_API_KEY) {
      headers["X-API-Key"] = String(window.TOOLSPAGE_API_KEY);
    }

    return headers;
  }

  async function inspectSource(sourceUrl, runtime, rightsConfirmed) {
    const response = await fetch(ToolspageApi.buildApiUrl("/api/v1/jobs/video-download-inspect"), {
      method: "POST",
      headers: makeInspectHeaders(runtime),
      body: JSON.stringify({
        sourceUrl,
        rightsConfirmed: Boolean(rightsConfirmed),
        allowPlaylist: false,
      }),
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || `Inspect failed (${response.status})`);
    }

    const payload = await response.json();
    return payload && payload.metadata ? payload.metadata : {};
  }

  async function inspectSourceBestEffort(sourceUrl, runtime, rightsConfirmed) {
    try {
      return await inspectSource(sourceUrl, runtime, rightsConfirmed);
    } catch (firstError) {
      // Transient network/abort races can happen on slower links; retry once.
      const firstMessage = String(firstError && firstError.message ? firstError.message : firstError || "");
      if (!/cancelled by client|inspect failed|network|timeout/i.test(firstMessage)) {
        throw firstError;
      }

      try {
        return await inspectSource(sourceUrl, runtime, rightsConfirmed);
      } catch (_secondError) {
        return null;
      }
    }
  }

  async function inspectImageFallbackViaServer(sourceUrl, runtime, rightsConfirmed) {
    try {
    const response = await fetch(ToolspageApi.buildApiUrl("/api/v1/jobs/image-inspect"), {
        method: "POST",
        headers: makeInspectHeaders(runtime),
        body: JSON.stringify({
          sourceUrl,
          rightsConfirmed: Boolean(rightsConfirmed),
        }),
      });

      if (!response.ok) {
        return null;
      }

      const payload = await response.json().catch(() => ({}));
      return payload && payload.metadata ? payload.metadata : null;
    } catch (_err) {
      return null;
    }
  }

  function pickBestQualityProfile(metadata, mode, fallbackProfile) {
    const profiles = Array.isArray(metadata && metadata.qualityProfiles) ? metadata.qualityProfiles : [];
    const candidates = profiles.filter((item) => {
      const profile = item && item.profile ? String(item.profile) : "";
      if (!profile) {
        return false;
      }
      if (mode === "audio") {
        return isAudioProfile(profile);
      }
      return !isAudioProfile(profile);
    });

    if (candidates.length === 0) {
      return fallbackProfile;
    }

    candidates.sort((a, b) => {
      const rankA = Number.isFinite(a.rank) ? Number(a.rank) : Number.MAX_SAFE_INTEGER;
      const rankB = Number.isFinite(b.rank) ? Number(b.rank) : Number.MAX_SAFE_INTEGER;
      return rankA - rankB;
    });

    const best = candidates[0] && candidates[0].profile ? String(candidates[0].profile) : "";
    return best || fallbackProfile;
  }

  function pickBestImageCandidate(metadata) {
    const candidates = [];

    if (metadata && metadata.thumbnail) {
      candidates.push({
        url: String(metadata.thumbnail),
        width: 0,
        height: 0,
      });
    }

    if (Array.isArray(metadata && metadata.thumbnails)) {
      for (const thumb of metadata.thumbnails) {
        if (!thumb || !thumb.url) {
          continue;
        }
        candidates.push({
          url: String(thumb.url),
          width: Number.isFinite(Number(thumb.width)) ? Number(thumb.width) : 0,
          height: Number.isFinite(Number(thumb.height)) ? Number(thumb.height) : 0,
        });
      }
    }

    if (candidates.length === 0) {
      return null;
    }

    candidates.sort((a, b) => {
      const areaA = a.width * a.height;
      const areaB = b.width * b.height;
      if (areaA !== areaB) {
        return areaB - areaA;
      }
      return b.width - a.width;
    });

    return candidates[0];
  }

  function inferImageFileName(sourceUrl, imageUrl) {
    const defaultName = `${expectedPlatform || "source"}-image.jpg`;
    try {
      const parsed = new URL(imageUrl || sourceUrl);
      const file = String(parsed.pathname || "").split("/").pop() || "";
      if (!file) {
        return defaultName;
      }
      if (/\.[a-zA-Z0-9]{2,5}$/.test(file)) {
        return file;
      }
      return `${file}.jpg`;
    } catch (_err) {
      return defaultName;
    }
  }

  async function downloadBestImage(metadata, sourceUrl) {
    const candidate = pickBestImageCandidate(metadata);
    if (!candidate || !candidate.url) {
      throw new Error("No downloadable image found for this pin.");
    }

    const fileName = inferImageFileName(sourceUrl, candidate.url);
    try {
      const response = await fetch(candidate.url);
      if (!response.ok) {
        throw new Error(`Image fetch failed (${response.status})`);
      }
      const blob = await response.blob();
      ToolspageApi.renderDownloadResult(
        form,
        "Best quality image is ready.",
        blob,
        fileName,
      );
      return true;
    } catch (_fetchError) {
      const resultBox = form.querySelector("[data-result]");
      const resultText = form.querySelector("[data-result-text]");
      const downloadLink = form.querySelector("[data-download-link]");
      if (resultBox && resultText && downloadLink) {
        resultText.textContent = "Best quality image found. Open direct link to save image.";
        downloadLink.href = candidate.url;
        downloadLink.target = "_blank";
        downloadLink.rel = "noopener noreferrer";
        downloadLink.textContent = "Open original image";
        downloadLink.hidden = false;
        resultBox.classList.remove("is-error");
        resultBox.classList.add("is-success");
        resultBox.hidden = false;
      }
      return false;
    }
  }

  function detectPlatform(value) {
    const text = String(value || "").toLowerCase();
    if (/youtu\.be|youtube\.com/.test(text)) return "youtube";
    if (/vimeo\.com/.test(text)) return "vimeo";
    if (/pinterest\.com|pin\.it/.test(text)) return "pinterest";
    if (/tiktok\.com|vm\.tiktok|vt\.tiktok/.test(text)) return "tiktok";
    if (/instagram\.com/.test(text)) return "instagram";
    if (/facebook\.com|fb\.watch/.test(text)) return "facebook";
    if (/soundcloud\.com/.test(text)) return "soundcloud";
    return "generic";
  }

  function syncModeControls() {
    const mode = modeEl.value;
    if (mode === "image") {
      qualityEl.disabled = true;
      videoFormatEl.closest("div").hidden = true;
      audioFormatEl.closest("div").hidden = true;
      return;
    }

    qualityEl.disabled = false;
    const qualityMode = modeFromQuality(qualityEl.value);
    if (mode === "audio" && qualityMode !== "audio") {
      qualityEl.value = "audio-high";
    }
    if (mode === "video" && qualityMode === "audio") {
      qualityEl.value = "1080p";
    }
    const resolvedMode = modeFromQuality(qualityEl.value);
    videoFormatEl.closest("div").hidden = resolvedMode === "audio";
    audioFormatEl.closest("div").hidden = resolvedMode !== "audio";
    modeEl.value = resolvedMode;
  }

  ToolspageApi.trackEvent("tool_page_view", { toolName });
  syncModeControls();

  sourceUrlEl.addEventListener("input", () => {
    const detected = detectPlatform(sourceUrlEl.value);
    if (!sourceUrlEl.value.trim()) {
      platformHintEl.textContent = "";
      return;
    }

    if (expectedPlatform && detected !== "generic" && detected !== expectedPlatform) {
      platformHintEl.textContent = `Detected ${detected}. This page is optimized for ${expectedPlatform} URLs.`;
      return;
    }

    platformHintEl.textContent = `Detected platform: ${detected}`;
  });

  modeEl.addEventListener("change", syncModeControls);
  qualityEl.addEventListener("change", syncModeControls);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();



    const sourceUrl = normalizeSourceUrl(sourceUrlEl.value);
    if (!sourceUrl) {
      runtimeUi.setStatus("A source URL is required.", true);
      return;
    }

    try {
      new URL(sourceUrl);
    } catch (_err) {
      runtimeUi.setStatus("Invalid URL format.", true);
      return;
    }
    sourceUrlEl.value = sourceUrl;

    try {
      runtimeUi.setBusy(true, "Processing...");
      runtimeUi.resetProgress();
      runtimeUi.setStatus("Queuing download job...", false);

      const runtime = await ToolspageApi.getRuntimeConfig();
      if (runtime && runtime.__fallback) {
        runtimeUi.setStatus(
          "Cannot reach API config endpoint. Start the server with npm start and open this page from http://localhost:8080.",
          true,
        );
        return;
      }

      if (!runtime.media || !runtime.media.urlIngestEnabled) {
        runtimeUi.setStatus("URL mode is disabled on this server.", true);
        return;
      }

      let mode = String(modeEl.value || "video").toLowerCase();
      let qualityProfile = String(qualityEl.value || "1080p");

      runtimeUi.setStatus("Inspecting source for best quality...", false);
      const metadata = await inspectSourceBestEffort(sourceUrl, runtime, true);

      if (mode === "image") {
        const imageMetadata = metadata || await inspectImageFallbackViaServer(sourceUrl, runtime, true);
        if (!imageMetadata) {
          runtimeUi.setStatus(
            "Image inspection is temporarily unavailable. Try again in a moment or switch to video mode.",
            true,
          );
          return;
        }
        runtimeUi.setProgress({ status: "running", stage: "collecting-image", progress: 65 });
        await downloadBestImage(imageMetadata, sourceUrl);
        runtimeUi.setProgress({ status: "succeeded", stage: "completed", progress: 100, downloadPercent: 100 });
        runtimeUi.setStatus("Done. Best image quality prepared.", false);
        return;
      }

      if (metadata) {
        qualityProfile = pickBestQualityProfile(metadata, mode, qualityProfile);
      } else {
        runtimeUi.setStatus("Inspection unavailable. Proceeding with selected quality profile.", false);
      }
      mode = modeFromQuality(qualityProfile);

      const payload = {
        sourceUrl,
        rightsConfirmed: true,
        mode,
        qualityProfile,
        videoFormat: videoFormatEl.value,
        audioFormat: audioFormatEl.value,
        allowPlaylist: false,
        includeSubtitles: false,
      };

      runtimeUi.setStatus(`Queuing best-quality ${mode} download...`, false);

      const flow = await ToolspageApi.runJobFlow({
        startJob: () => ToolspageApi.startJsonJob({
          endpoint: "/api/v1/jobs/video-download-url",
          payload,
        }),
        runtimeUi,
        fallbackName: mode === "audio" ? `${expectedPlatform || "source"}-audio.mp3` : `${expectedPlatform || "source"}-video.mp4`,
        onTick: (tick) => {
          if (tick && tick.progress) {
            runtimeUi.setProgress(tick.progress);
          } else {
            runtimeUi.setProgress({ status: tick.status, stage: tick.status, progress: tick.status === "queued" ? 5 : 25 });
          }
          runtimeUi.setStatus(`Job ${tick.status}...`, false);
        },
      });

      const result = flow.result;
      const job = flow.completedJob;

      const requestedQuality = job && job.selectedQualityProfile;
      const resolvedQuality = job && job.resolvedQualityProfile;
      const qualityNote = requestedQuality && resolvedQuality && requestedQuality !== resolvedQuality
        ? ` Fallback applied: ${resolvedQuality}.`
        : ` Best quality selected: ${resolvedQuality || qualityProfile}.`;

      runtimeUi.setProgress({ status: "succeeded", stage: "completed", progress: 100, downloadPercent: 100 });
      runtimeUi.renderResult(
        `Download complete.${qualityNote}`,
        result.blob,
        result.fileName,
      );
      runtimeUi.setStatus("Done. File downloaded successfully.", false);
    } catch (error) {
      runtimeUi.setStatus(error.message || "Download failed", true);
      runtimeUi.setProgress({ status: "failed", stage: "failed", progress: 100 });
    } finally {
      runtimeUi.setBusy(false);
    }
  });
}
