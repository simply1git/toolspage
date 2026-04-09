const form = document.getElementById("videoDownloaderForm");

if (form) {
  const SETTINGS_KEY = "toolspage_video_downloader_settings_v2";

  const sourceUrlEl = document.getElementById("downloadSourceUrl");
  const qualityProfileEl = document.getElementById("downloadQualityProfile");
  const videoFormatEl = document.getElementById("videoFormat");
  const audioFormatEl = document.getElementById("audioFormat");
  const allowPlaylistEl = document.getElementById("allowPlaylist");
  const playlistMaxItemsEl = document.getElementById("playlistMaxItems");
  const includeSubtitlesEl = document.getElementById("includeSubtitles");
  const subtitleFormatEl = document.getElementById("subtitleFormat");
  const subtitleLanguagesEl = document.getElementById("subtitleLanguages");
  const statusEl = document.getElementById("videoDownloaderStatus");
  const platformHintEl = document.getElementById("platformHint");
  const formatControlsEl = document.getElementById("formatControls");
  const progressStageEl = document.getElementById("progressStage");
  const progressPercentEl = document.getElementById("progressPercent");
  const progressTrackEl = document.getElementById("progressTrack");
  const progressFillEl = document.getElementById("progressFill");
  const progressSpeedEl = document.getElementById("progressSpeed");
  const progressEtaEl = document.getElementById("progressEta");
  const progressSizeEl = document.getElementById("progressSize");
  const progressTimelineEl = document.getElementById("progressTimeline");
  const metadataPanelEl = document.getElementById("metadataPanel");
  const metadataSummaryEl = document.getElementById("metadataSummary");
  const metadataPreviewEl = document.getElementById("metadataPreview");
  const pasteUrlBtnEl = document.getElementById("pasteUrlBtn");
  const clearUrlBtnEl = document.getElementById("clearUrlBtn");
  const analyzeUrlBtnEl = document.getElementById("analyzeUrlBtn");
  const presetGridEl = document.getElementById("presetGrid");
  const playlistPanelEl = document.getElementById("playlistPanel");
  const playlistStatTotalEl = document.getElementById("playlistStatTotal");
  const playlistStatDoneEl = document.getElementById("playlistStatDone");
  const playlistStatFailedEl = document.getElementById("playlistStatFailed");
  const playlistStatSkippedEl = document.getElementById("playlistStatSkipped");
  const playlistNoteEl = document.getElementById("playlistNote");
  const staticQualityMarkup = qualityProfileEl ? qualityProfileEl.innerHTML : "";
  const runtimeUi = ToolspageApi.createToolRuntime({
    form,
    statusEl,
  });

  let sseProgressActive = false;
  let lastPipelineStage = "queued";
  let lastInspectedMetadata = null;
  let fallbackProgressValue = 0;

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

  function detectPlatform(value) {
    const text = String(value || "").toLowerCase();
    if (!text) return null;
    if (/youtu\.be|youtube\.com|youtube-nocookie\.com/.test(text)) return "YouTube";
    if (/vimeo\.com/.test(text)) return "Vimeo";
    if (/tiktok\.com|vm\.tiktok|vt\.tiktok/.test(text)) return "TikTok";
    if (/soundcloud\.com/.test(text)) return "SoundCloud";
    if (/facebook\.com|fb\.watch/.test(text)) return "Facebook";
    if (/instagram\.com/.test(text)) return "Instagram";
    if (/twitter\.com|x\.com/.test(text)) return "X";
    return "Detected URL";
  }

  function getModeFromProfile(profile) {
    return String(profile || "").startsWith("audio-") ? "audio" : "video";
  }

  const PIPELINE_PHASES = ["queued", "metadata", "downloading", "merging", "storing", "completed"];

  function updatePhaseChips(stage, jobStatus) {
    if (!progressTimelineEl) return;
    const stageKey = String(stage || "queued").toLowerCase().replace(/ /g, "-");
    const isFailed = jobStatus === "failed";
    const isCompleted = jobStatus === "succeeded" || stageKey === "completed";

    if (PIPELINE_PHASES.includes(stageKey)) {
      lastPipelineStage = stageKey;
    }

    const effectiveStage = isFailed ? lastPipelineStage : stageKey;
    const activeIdx = Math.max(0, PIPELINE_PHASES.indexOf(effectiveStage));

    const chips = progressTimelineEl.querySelectorAll(".phase-chip");
    chips.forEach((chip, idx) => {
      let status;
      if (isCompleted) {
        status = "done";
      } else if (isFailed) {
        if (idx < activeIdx) status = "done";
        else if (idx === activeIdx) status = "failed";
        else status = "pending";
      } else if (idx < activeIdx) {
        status = "done";
      } else if (idx === activeIdx) {
        status = "active";
      } else {
        status = "pending";
      }
      chip.dataset.status = status;
    });
  }

  function setProgressState(payload) {
    const progress = Number.isFinite(payload && payload.progress)
      ? Math.max(0, Math.min(100, Math.round(payload.progress)))
      : 0;
    const stage = payload && payload.stage ? String(payload.stage).replace(/-/g, " ") : "queued";
    const displayPercent = Number.isFinite(payload && payload.downloadPercent)
      ? `${Number(payload.downloadPercent).toFixed(1)}%`
      : `${progress}%`;

    if (progressStageEl) {
      progressStageEl.textContent = stage;
    }
    if (progressPercentEl) {
      progressPercentEl.textContent = displayPercent;
    }
    if (progressFillEl) {
      progressFillEl.style.width = `${progress}%`;
    }
    if (progressTrackEl) {
      progressTrackEl.setAttribute("aria-valuenow", String(progress));
    }
    if (progressSpeedEl) {
      progressSpeedEl.textContent = `Speed: ${payload && payload.speed ? payload.speed : "-"}`;
    }
    if (progressEtaEl) {
      progressEtaEl.textContent = `ETA: ${payload && payload.eta ? payload.eta : "-"}`;
    }
    if (progressSizeEl) {
      progressSizeEl.textContent = `Size: ${payload && payload.totalSize ? payload.totalSize : "-"}`;
    }

    updatePhaseChips(stage, payload && payload.status ? payload.status : "running");
  }

  function resetProgressUi() {
    fallbackProgressValue = 0;
    lastPipelineStage = "queued";
    if (playlistPanelEl) playlistPanelEl.hidden = true;
    setProgressState({ status: "queued", stage: "queued", progress: 0 });
  }

  function getPreferredQualityFromStorage() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (!raw) {
        return null;
      }
      const parsed = JSON.parse(raw);
      return parsed && parsed.qualityProfile ? String(parsed.qualityProfile) : null;
    } catch (_err) {
      return null;
    }
  }

  function renderDynamicQualityProfiles(profiles) {
    if (!qualityProfileEl) {
      return;
    }

    const candidates = Array.isArray(profiles)
      ? profiles.filter((item) => item && item.profile && item.label)
      : [];

    if (candidates.length === 0) {
      qualityProfileEl.innerHTML = staticQualityMarkup;
      const preferred = getPreferredQualityFromStorage();
      if (preferred) {
        qualityProfileEl.value = preferred;
      }
      toggleModeControls();
      return;
    }

    const groups = {
      videoUltra: { label: "Video - Ultra", items: [] },
      videoHigh: { label: "Video - High", items: [] },
      videoStandard: { label: "Video - Standard", items: [] },
      audio: { label: "Audio Only", items: [] },
    };

    for (const item of candidates) {
      const profile = String(item.profile);
      const label = String(item.label);
      const meta = [];
      if (Number.isFinite(item.height)) meta.push(`${item.height}p`);
      if (Number.isFinite(item.fps)) meta.push(`${item.fps}fps`);
      const badges = [];
      if (item.hasMuxedAudio) badges.push("⚡ muxed");
      if (Number.isFinite(item.formatCount) && item.formatCount > 1) badges.push(`${item.formatCount} fmt`);
      const metaPart = meta.length > 0 ? ` (${meta.join(", ")})` : "";
      const badgePart = badges.length > 0 ? ` · ${badges.join(", ")}` : "";
      const optionText = `${label}${metaPart}${badgePart}`;

      if (profile.startsWith("audio-")) {
        groups.audio.items.push({ value: profile, text: optionText });
      } else if (profile === "4k60" || profile === "4k") {
        groups.videoUltra.items.push({ value: profile, text: optionText });
      } else if (profile === "1440p60" || profile === "1440p" || profile === "1080p60" || profile === "1080p") {
        groups.videoHigh.items.push({ value: profile, text: optionText });
      } else {
        groups.videoStandard.items.push({ value: profile, text: optionText });
      }
    }

    qualityProfileEl.innerHTML = "";
    const orderedGroups = [groups.videoUltra, groups.videoHigh, groups.videoStandard, groups.audio];
    for (const group of orderedGroups) {
      if (group.items.length === 0) {
        continue;
      }
      const optgroup = document.createElement("optgroup");
      optgroup.label = group.label;
      for (const optionData of group.items) {
        const option = document.createElement("option");
        option.value = optionData.value;
        option.textContent = optionData.text;
        optgroup.appendChild(option);
      }
      qualityProfileEl.appendChild(optgroup);
    }

    const preferred = getPreferredQualityFromStorage();
    if (preferred && candidates.some((item) => item.profile === preferred)) {
      qualityProfileEl.value = preferred;
    }

    toggleModeControls();
  }

  function toggleModeControls() {
    const mode = getModeFromProfile(qualityProfileEl.value);
    if (formatControlsEl) {
      formatControlsEl.hidden = mode === "audio";
    }
  }

  function saveSettings() {
    const payload = {
      qualityProfile: qualityProfileEl.value,
      videoFormat: videoFormatEl.value,
      audioFormat: audioFormatEl.value,
      allowPlaylist: allowPlaylistEl.checked,
      playlistMaxItems: playlistMaxItemsEl.value,
      includeSubtitles: includeSubtitlesEl.checked,
      subtitleFormat: subtitleFormatEl.value,
      subtitleLanguages: subtitleLanguagesEl.value,
    };
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(payload));
  }

  function loadSettings() {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) {
      return;
    }

    try {
      const payload = JSON.parse(raw);
      if (payload.qualityProfile) qualityProfileEl.value = payload.qualityProfile;
      if (payload.videoFormat) videoFormatEl.value = payload.videoFormat;
      if (payload.audioFormat) audioFormatEl.value = payload.audioFormat;
      if (typeof payload.allowPlaylist === "boolean") allowPlaylistEl.checked = payload.allowPlaylist;
      if (payload.playlistMaxItems) playlistMaxItemsEl.value = payload.playlistMaxItems;
      if (typeof payload.includeSubtitles === "boolean") includeSubtitlesEl.checked = payload.includeSubtitles;
      if (payload.subtitleFormat) subtitleFormatEl.value = payload.subtitleFormat;
      if (typeof payload.subtitleLanguages === "string") subtitleLanguagesEl.value = payload.subtitleLanguages;
    } catch (_err) {
      // Ignore malformed settings and continue with defaults.
    }
  }

  function formatProgressStatus(data) {
    const stage = data && data.stage ? String(data.stage).replace(/-/g, " ") : "processing";
    const status = data && data.status ? String(data.status) : "running";
    const percent = Number.isFinite(data && data.downloadPercent)
      ? `${Number(data.downloadPercent).toFixed(1)}%`
      : (Number.isFinite(data && data.progress) ? `${Math.round(data.progress)}%` : null);

    const extras = [];
    if (data && data.speed) {
      extras.push(`speed ${data.speed}`);
    }
    if (data && data.eta) {
      extras.push(`ETA ${data.eta}`);
    }

    const base = `${stage} (${status})`;
    const withPercent = percent ? `${base} - ${percent}` : base;
    return extras.length > 0 ? `${withPercent} - ${extras.join(", ")}` : withPercent;
  }

  async function streamProgress(jobId) {
    if (!window.EventSource) {
      return;
    }

    let progressUrl = ToolspageApi.buildApiUrl(`/api/v1/jobs/${jobId}/progress`);
    if (window.TOOLSPAGE_API_KEY) {
      progressUrl += `?apiKey=${encodeURIComponent(window.TOOLSPAGE_API_KEY)}`;
    }
    const source = new EventSource(progressUrl);
    source.addEventListener("status", (event) => {
      const data = JSON.parse(event.data || "{}");
      sseProgressActive = true;
      ToolspageApi.setStatus(statusEl, formatProgressStatus(data), false);
      setProgressState(data);
    });
    source.addEventListener("complete", () => {
      sseProgressActive = false;
      source.close();
    });
    source.addEventListener("error", () => {
      sseProgressActive = false;
      source.close();
    });
  }

  async function analyzeSourceUrl() {
    const sourceUrl = normalizeSourceUrl(sourceUrlEl.value);
    if (!sourceUrl) {
      ToolspageApi.setStatus(statusEl, "Paste a source URL first.", true);
      return;
    }

    const runtime = await ToolspageApi.getRuntimeConfig();
    if (!runtime.media || !runtime.media.urlIngestEnabled) {
      ToolspageApi.setStatus(statusEl, "URL mode is disabled on this server.", true);
      return;
    }

    ToolspageApi.setStatus(statusEl, "Inspecting metadata...", false);

    const headers = {
      "content-type": "application/json",
    };
    if (runtime.apiKeyRequired && window.TOOLSPAGE_API_KEY) {
      headers["X-API-Key"] = String(window.TOOLSPAGE_API_KEY);
    }

    const inspectResponse = await fetch(ToolspageApi.buildApiUrl("/api/v1/jobs/video-download-inspect"), {
      method: "POST",
      headers,
      body: JSON.stringify({
        sourceUrl,
        rightsConfirmed: true,
        allowPlaylist: allowPlaylistEl.checked,
        playlistMaxItems: Number.parseInt(playlistMaxItemsEl.value || "", 10) || 25,
      }),
    });

    if (!inspectResponse.ok) {
      const body = await inspectResponse.json().catch(() => ({}));
      throw new Error(body.error || `Request failed (${inspectResponse.status})`);
    }

    const response = await inspectResponse.json();
    const metadata = response.metadata || {};
    lastInspectedMetadata = metadata;
    renderDynamicQualityProfiles(metadata.qualityProfiles);
    if (metadataPanelEl) {
      metadataPanelEl.hidden = false;
    }
    if (metadataSummaryEl) {
      const title = metadata.title ? String(metadata.title) : "Unknown title";
      const duration = Number.isFinite(metadata.durationSec) ? `${metadata.durationSec}s` : "Unknown duration";
      const count = Array.isArray(metadata.entries) ? metadata.entries.length : 0;
      metadataSummaryEl.textContent = `${title} | ${duration}${count > 0 ? ` | ${count} playlist entries` : ""}`;
    }
    if (metadataPreviewEl) {
      metadataPreviewEl.textContent = JSON.stringify(metadata, null, 2);
    }
    ToolspageApi.setStatus(statusEl, "Metadata inspection complete.", false);
  }

  ToolspageApi.trackEvent("tool_page_view", { toolName: "YouTube Downloader" });

  loadSettings();
  toggleModeControls();
  resetProgressUi();

  const PRESETS = {
    archive: { qualityProfile: "1080p", videoFormat: "mkv", label: "Archive preset: 1080p MKV selected." },
    mobile: { qualityProfile: "480p", videoFormat: "mp4", label: "Mobile preset: 480p MP4 selected." },
    audio: { qualityProfile: "audio-high", label: "Audio-only preset: HQ MP3 selected." },
    creator: { qualityProfile: "1080p60", videoFormat: "mp4", label: "Creator preset: 1080p60 MP4 selected." },
  };

  if (presetGridEl) {
    presetGridEl.addEventListener("click", (event) => {
      const btn = event.target.closest("[data-preset]");
      if (!btn) return;
      const preset = PRESETS[btn.dataset.preset];
      if (!preset) return;
      if (preset.qualityProfile && qualityProfileEl) qualityProfileEl.value = preset.qualityProfile;
      if (preset.videoFormat && videoFormatEl) videoFormatEl.value = preset.videoFormat;
      toggleModeControls();
      saveSettings();
      ToolspageApi.setStatus(statusEl, preset.label, false);
    });
  }

  sourceUrlEl.addEventListener("input", () => {
    const platform = detectPlatform(sourceUrlEl.value);
    if (platformHintEl) {
      platformHintEl.textContent = platform ? `Platform: ${platform}` : "";
    }
  });

  qualityProfileEl.addEventListener("change", () => {
    toggleModeControls();
    saveSettings();
  });

  [
    videoFormatEl,
    audioFormatEl,
    allowPlaylistEl,
    playlistMaxItemsEl,
    includeSubtitlesEl,
    subtitleFormatEl,
    subtitleLanguagesEl,
  ].forEach((el) => {
    el.addEventListener("change", saveSettings);
  });

  if (pasteUrlBtnEl) {
    pasteUrlBtnEl.addEventListener("click", async () => {
      try {
        const text = await navigator.clipboard.readText();
        sourceUrlEl.value = String(text || "").trim();
        sourceUrlEl.dispatchEvent(new Event("input"));
      } catch (_err) {
        ToolspageApi.setStatus(statusEl, "Clipboard read failed. Paste manually.", true);
      }
    });
  }

  if (clearUrlBtnEl) {
    clearUrlBtnEl.addEventListener("click", () => {
      sourceUrlEl.value = "";
      sourceUrlEl.dispatchEvent(new Event("input"));
      ToolspageApi.setStatus(statusEl, "URL cleared.", false);
    });
  }

  if (analyzeUrlBtnEl) {
    analyzeUrlBtnEl.addEventListener("click", async () => {
      try {
        await analyzeSourceUrl();
      } catch (error) {
        ToolspageApi.setStatus(statusEl, error.message, true);
      }
    });
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();



    const sourceUrl = String(sourceUrlEl.value || "").trim();
    const qualityProfile = String(qualityProfileEl.value || "4k60");
    const mode = getModeFromProfile(qualityProfile);
    const subtitleLanguages = String(subtitleLanguagesEl.value || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);

    if (!sourceUrl) {
      ToolspageApi.setStatus(statusEl, "A source URL is required.", true);
      return;
    }

    // Validate URL format
    try {
      new URL(sourceUrl);
    } catch (_err) {
      ToolspageApi.setStatus(statusEl, "Invalid URL format. Please check and try again.", true);
      return;
    }
    sourceUrlEl.value = sourceUrl;

    try {
      runtimeUi.setBusy(true, "Processing...");
      resetProgressUi();
      saveSettings();

      const runtime = await ToolspageApi.getRuntimeConfig();
      if (!runtime.media || !runtime.media.urlIngestEnabled) {
        ToolspageApi.setStatus(statusEl, "URL mode is disabled on this server.", true);
        return;
      }

      ToolspageApi.setStatus(statusEl, "Queuing downloader job...", false);
      
      let created;
      let retries = 2;
      let lastError = null;

      // Retry logic for job creation
      while (retries >= 0) {
        try {
          created = await ToolspageApi.startJsonJob({
            endpoint: "/api/v1/jobs/video-download-url",
            payload: {
              sourceUrl,
              rightsConfirmed: true,
              qualityProfile,
              videoFormat: videoFormatEl.value,
              audioFormat: audioFormatEl.value,
              allowPlaylist: allowPlaylistEl.checked,
              playlistMaxItems: Number.parseInt(playlistMaxItemsEl.value || "", 10) || 25,
              includeSubtitles: includeSubtitlesEl.checked,
              subtitleFormat: subtitleFormatEl.value,
              subtitleLanguages,
            },
          });
          break; // Success!
        } catch (err) {
          lastError = err;
          retries--;
          if (retries >= 0) {
            ToolspageApi.setStatus(statusEl, `Retrying... (${retries + 1} attempt(s) left)`, false);
            await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1s before retry
          }
        }
      }

      if (!created) {
        throw lastError || new Error("Failed to create download job after retries");
      }

      ToolspageApi.setStatus(statusEl, `Job created (ID: ${created.id}). Streaming progress...`, false);
      streamProgress(created.id);
      
      const completedJob = await ToolspageApi.waitForJob(created.id, (tick) => {
        if (!sseProgressActive) {
          let calculatedProgress = fallbackProgressValue;
          let calculatedStage = "queued";
          let statusText = "queued";

          const snapshot = tick && tick.progress ? tick.progress : null;
          if (snapshot && Number.isFinite(snapshot.progress)) {
            calculatedProgress = Math.max(fallbackProgressValue, Math.round(snapshot.progress));
            calculatedStage = snapshot.stage ? String(snapshot.stage) : calculatedStage;
          }

          if (tick.status === "queued") {
            calculatedProgress = 5;
            calculatedStage = "queued";
            statusText = "queued";
          } else if (tick.status === "running") {
            calculatedProgress = Math.max(calculatedProgress, 15);
            statusText = "running";
          } else if (tick.status === "succeeded") {
            calculatedProgress = 100;
            calculatedStage = "completed";
            statusText = "completed";
          } else if (tick.status === "failed") {
            calculatedProgress = 100;
            calculatedStage = "failed";
            statusText = "failed";
          }

          fallbackProgressValue = Math.max(fallbackProgressValue, calculatedProgress);
          const payload = {
            status: tick.status,
            stage: calculatedStage,
            progress: fallbackProgressValue,
          };
          setProgressState(payload);

          const messages = {
            "queued": "Queued, waiting for processing...",
            "running": "Downloading media...",
            "succeeded": "Finalizing download...",
            "failed": "Download failed. Check URL and try again.",
          };

          ToolspageApi.setStatus(statusEl, `${statusText} ${messages[tick.status] || tick.status}`, tick.status === "failed");
        }
      });

      const fallbackName = mode === "audio" ? "download-audio.mp3" : "download-video.mp4";
      try {
        const result = await ToolspageApi.downloadJobResult(created.id, fallbackName, {
          downloadUrl: completedJob && completedJob.downloadUrl,
          downloadPath: completedJob && completedJob.downloadPath,
        });
        const requestedQuality = completedJob && completedJob.selectedQualityProfile;
        const resolvedQuality = completedJob && completedJob.resolvedQualityProfile;
        const qualityNote = requestedQuality && resolvedQuality && requestedQuality !== resolvedQuality
          ? ` Completed using fallback quality ${resolvedQuality}.`
          : "";
        ToolspageApi.renderDownloadResult(
          form,
          `Download complete. File ready.${qualityNote}`,
          result.blob,
          result.fileName,
        );
        setProgressState({ status: "succeeded", stage: "completed", progress: 100, downloadPercent: 100 });
        runtimeUi.setStatus("Done. File downloaded successfully.", false);

        // Show playlist summary panel if playlist mode was active
        if (allowPlaylistEl.checked && playlistPanelEl) {
          const expectedCount = lastInspectedMetadata && Array.isArray(lastInspectedMetadata.entries)
            ? lastInspectedMetadata.entries.length
            : (Number.isFinite(Number(playlistMaxItemsEl.value)) ? Number(playlistMaxItemsEl.value) : null);
          if (playlistStatTotalEl) playlistStatTotalEl.textContent = expectedCount != null ? String(expectedCount) : "?";
          if (playlistStatDoneEl) playlistStatDoneEl.textContent = "✓";
          if (playlistStatFailedEl) playlistStatFailedEl.textContent = "0";
          if (playlistStatSkippedEl) playlistStatSkippedEl.textContent = "—";
          if (playlistNoteEl) {
            playlistNoteEl.textContent = expectedCount
              ? `Processed up to ${expectedCount} items. Download contains all available results.`
              : "Playlist processed. Download contains all available results.";
          }
          playlistPanelEl.hidden = false;
        }
      } catch (downloadError) {
        // If auto-download fails, show manual download link with retry option
        console.warn("Auto-download failed, showing manual download option", downloadError);
        
        const resultBox = form.parentElement.querySelector("[data-result]");
        if (resultBox) {
          resultBox.hidden = false;
          const statusLine = resultBox.querySelector("[data-result-text]");
          if (statusLine) {
              statusLine.textContent = "Processing complete. Your download is ready.";
              const directLink = document.createElement("a");
              directLink.href = ToolspageApi.buildApiUrl(`/api/v1/jobs/${created.id}/download`);
              directLink.download = fallbackName;
              directLink.textContent = " Try direct download";
              statusLine.appendChild(directLink);
          }
          
          const downloadLink = resultBox.querySelector("[data-download-link]");
          if (downloadLink) {
            downloadLink.href = ToolspageApi.buildApiUrl(`/api/v1/jobs/${created.id}/download`);
            downloadLink.download = fallbackName;
            downloadLink.textContent = "Download now";
            downloadLink.onclick = () => false; // Allow natural download behavior
          }
        }
        
        runtimeUi.setStatus("Processing complete. Download ready.", false);
      }
    } catch (error) {
      const message = error.message || "Unknown error occurred";
      console.error("Download error:", error);
      runtimeUi.setStatus(`Error: ${message}`, true);
    } finally {
      runtimeUi.setBusy(false);
    }
  });
}
