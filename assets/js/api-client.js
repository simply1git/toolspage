function trackEvent(name, payload) {
  const key = "toolspage_analytics";
  let current = [];
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || "[]");
    if (Array.isArray(parsed)) {
      current = parsed;
    }
  } catch (_err) {
    current = [];
  }
  current.push({ name, payload, timestamp: new Date().toISOString() });
  localStorage.setItem(key, JSON.stringify(current.slice(-400)));
}

function getApiBase() {
  if (window.TOOLSPAGE_API_BASE) {
    return String(window.TOOLSPAGE_API_BASE).replace(/\/$/, "");
  }
  return "";
}

function buildApiUrl(endpoint) {
  return `${getApiBase()}${endpoint}`;
}

let runtimeConfig = null;
const DEFAULT_RUNTIME_CONFIG = {
  apiKeyRequired: false,
  asyncThresholdMb: 8,
  media: {
    urlIngestEnabled: false,
  },
  __fallback: true,
};

async function getRuntimeConfig() {
  if (runtimeConfig) {
    return runtimeConfig;
  }

  try {
    const response = await fetch(buildApiUrl("/api/v1/config"));
    if (!response.ok) {
      throw new Error(`Config request failed (${response.status})`);
    }

    const body = await response.json().catch(() => {
      throw new Error("Config response was not valid JSON");
    });

    runtimeConfig = body;
    return runtimeConfig;
  } catch (error) {
    console.warn("Runtime config load failed, using fallback defaults", error);
    runtimeConfig = { ...DEFAULT_RUNTIME_CONFIG };
    return runtimeConfig;
  }
}

function setStatus(el, message, isError) {
  if (!el) {
    return;
  }
  const normalized = String(message || "")
    .replace(/[✅❌⏳📋🎉🚀📥]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  el.textContent = normalized;
  el.classList.toggle("status-error", Boolean(isError));
}

function parseDispositionFilename(contentDisposition, fallbackName) {
  if (!contentDisposition) {
    return fallbackName;
  }

  const match = /filename=\"?([^\";]+)\"?/i.exec(contentDisposition);
  return match ? match[1] : fallbackName;
}

async function submitFileTool({ endpoint, formData, fallbackName }) {
  const config = await getRuntimeConfig();
  const headers = {
    "X-Requested-With": "toolspage-web",
  };

  if (config.apiKeyRequired && window.TOOLSPAGE_API_KEY) {
    headers["X-API-Key"] = String(window.TOOLSPAGE_API_KEY);
  }

  const response = await fetch(buildApiUrl(endpoint), {
    method: "POST",
    body: formData,
    headers,
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${response.status})`);
  }

  const blob = await response.blob();
  const name = parseDispositionFilename(response.headers.get("content-disposition"), fallbackName);
  return { blob, fileName: name, headers: response.headers };
}

async function startAsyncJob({ endpoint, formData }) {
  const config = await getRuntimeConfig();
  const headers = {
    "X-Requested-With": "toolspage-web",
  };

  if (config.apiKeyRequired && window.TOOLSPAGE_API_KEY) {
    headers["X-API-Key"] = String(window.TOOLSPAGE_API_KEY);
  }

  const response = await fetch(buildApiUrl(endpoint), {
    method: "POST",
    body: formData,
    headers,
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${response.status})`);
  }

  const body = await response.json();
  return body.job;
}

async function startJsonJob({ endpoint, payload }) {
  const config = await getRuntimeConfig();
  const headers = {
    "X-Requested-With": "toolspage-web",
    "Content-Type": "application/json",
  };

  if (config.apiKeyRequired && window.TOOLSPAGE_API_KEY) {
    headers["X-API-Key"] = String(window.TOOLSPAGE_API_KEY);
  }

  const response = await fetch(buildApiUrl(endpoint), {
    method: "POST",
    headers,
    body: JSON.stringify(payload || {}),
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${response.status})`);
  }

  const body = await response.json();
  return body.job;
}

async function waitForJob(jobId, onTick) {
  return new Promise((resolve, reject) => {
    let url = buildApiUrl(`/api/v1/jobs/${encodeURIComponent(jobId)}/progress`);
    if (window.TOOLSPAGE_API_KEY) {
      url += `?apiKey=${encodeURIComponent(window.TOOLSPAGE_API_KEY)}`;
    }

    const source = new EventSource(url);

    source.addEventListener("status", (e) => {
      try {
        const payload = JSON.parse(e.data);
        if (onTick) onTick(payload);
      } catch (err) {}
    });

    source.addEventListener("complete", (e) => {
      try {
        const payload = JSON.parse(e.data);
        source.close();
        if (payload.status === "failed") {
          reject(new Error(payload.error || "Job failed"));
        } else {
          resolve(payload);
        }
      } catch (err) {
        source.close();
        reject(err);
      }
    });

    source.addEventListener("error", (e) => {
      source.close();
      if (e.data) {
        try {
          const errData = JSON.parse(e.data);
          reject(new Error(errData.error || "Connection error"));
          return;
        } catch(ex) {}
      }
      reject(new Error("Lost connection to live processing stream."));
    });
  });
}

async function downloadJobResult(jobId, fallbackName, options = {}) {
  const config = await getRuntimeConfig();
  const headers = {};
  if (config.apiKeyRequired && window.TOOLSPAGE_API_KEY) {
    headers["X-API-Key"] = String(window.TOOLSPAGE_API_KEY);
  }

  const candidates = [
    buildApiUrl(`/api/v1/jobs/${encodeURIComponent(jobId)}/download`),
  ];

  if (options.downloadUrl) {
    candidates.push(String(options.downloadUrl));
  }
  if (options.downloadPath) {
    candidates.push(buildApiUrl(String(options.downloadPath)));
  }

  let lastError = null;
  for (const endpoint of candidates) {
    const response = await fetch(endpoint, { headers });
    if (response.ok) {
      const blob = await response.blob();
      const fileName = parseDispositionFilename(response.headers.get("content-disposition"), fallbackName);
      return { blob, fileName, headers: response.headers };
    }

    const body = await response.json().catch(() => ({}));
    lastError = new Error(body.error || `Download failed (${response.status})`);
  }

  throw lastError || new Error("Download failed");
}

function renderDownloadResult(form, message, blob, fileName) {
  const resultBox = form.querySelector("[data-result]");
  const resultText = form.querySelector("[data-result-text]");
  const downloadLink = form.querySelector("[data-download-link]");

  if (!resultBox || !resultText || !downloadLink) {
    return;
  }

  const url = URL.createObjectURL(blob);
  if (downloadLink.dataset.objectUrl) {
    URL.revokeObjectURL(downloadLink.dataset.objectUrl);
  }
  resultText.textContent = message;
  downloadLink.href = url;
  downloadLink.dataset.objectUrl = url;
  downloadLink.download = fileName;
  downloadLink.textContent = `Download ${fileName}`;
  resultBox.hidden = false;
  
  if (window.playSuccessCue) {
    window.playSuccessCue();
  }
}

function createToolRuntime(options) {
  const form = options && options.form ? options.form : null;
  const statusEl = options && options.statusEl ? options.statusEl : null;
  const progress = options && options.progress ? options.progress : null;
  const submitButton = form ? form.querySelector('button[type="submit"]') : null;

  function setStatusMessage(message, isError) {
    setStatus(statusEl, message, Boolean(isError));
  }

  function setBusyState(isBusy, buttonLabel) {
    if (!submitButton) {
      return;
    }
    submitButton.disabled = Boolean(isBusy);
    if (buttonLabel) {
      submitButton.dataset.originalLabel = submitButton.dataset.originalLabel || submitButton.textContent;
      submitButton.textContent = buttonLabel;
    } else if (!isBusy && submitButton.dataset.originalLabel) {
      submitButton.textContent = submitButton.dataset.originalLabel;
    }
  }

  function setProgressState(event) {
    if (!progress) {
      return;
    }
    const stage = event && event.stage ? String(event.stage).replace(/-/g, " ") : "queued";
    const progressValue = Number.isFinite(event && event.progress)
      ? Math.max(0, Math.min(100, Math.round(event.progress)))
      : 0;
    const displayPercent = Number.isFinite(event && event.downloadPercent)
      ? `${Number(event.downloadPercent).toFixed(1)}%`
      : `${progressValue}%`;

    if (progress.stageEl) {
      progress.stageEl.textContent = stage;
    }
    if (progress.percentEl) {
      progress.percentEl.textContent = displayPercent;
    }
    if (progress.fillEl) {
      progress.fillEl.style.width = `${progressValue}%`;
    }
    if (progress.trackEl) {
      progress.trackEl.setAttribute("aria-valuenow", String(progressValue));
    }
  }

  return {
    setStatus: setStatusMessage,
    setBusy: setBusyState,
    setProgress: setProgressState,
    resetProgress() {
      setProgressState({ status: "queued", stage: "queued", progress: 0 });
    },
    renderResult(message, blob, fileName) {
      if (!form) {
        return;
      }
      renderDownloadResult(form, message, blob, fileName);
    },
  };
}

async function runJobFlow(options) {
  const startJob = options && options.startJob;
  if (typeof startJob !== "function") {
    throw new Error("runJobFlow requires a startJob function");
  }

  const runtimeUi = options && options.runtimeUi ? options.runtimeUi : null;
  const onTick = options && typeof options.onTick === "function" ? options.onTick : null;
  const fallbackName = options && options.fallbackName ? String(options.fallbackName) : "download.bin";
  const buildDownloadOptions = options && typeof options.buildDownloadOptions === "function"
    ? options.buildDownloadOptions
    : (completed) => ({
      downloadUrl: completed && completed.downloadUrl,
      downloadPath: completed && completed.downloadPath,
    });

  const createdJob = await startJob();
  const completedJob = await waitForJob(createdJob.id, (tick) => {
    if (onTick) {
      onTick(tick);
      return;
    }
    if (runtimeUi) {
      runtimeUi.setStatus(`Job ${tick.status}...`, false);
    }
  });

  const result = await downloadJobResult(
    createdJob.id,
    fallbackName,
    buildDownloadOptions(completedJob),
  );
  return { createdJob, completedJob, result };
}

async function submitWithAutoAsync(options) {
  const runtimeConfig = options && options.runtimeConfig ? options.runtimeConfig : DEFAULT_RUNTIME_CONFIG;
  const formData = options && options.formData;
  const fallbackName = options && options.fallbackName ? String(options.fallbackName) : "output.bin";
  const fileSizeBytes = Number(options && options.fileSizeBytes ? options.fileSizeBytes : 0);
  const runtimeUi = options && options.runtimeUi ? options.runtimeUi : null;
  const syncEndpoint = options && options.syncEndpoint ? String(options.syncEndpoint) : "";
  const asyncEndpoint = options && options.asyncEndpoint ? String(options.asyncEndpoint) : "";
  const asyncLabel = options && options.asyncLabel ? String(options.asyncLabel) : "Large file detected. Queuing background job...";
  const syncLabel = options && options.syncLabel ? String(options.syncLabel) : "Processing file...";
  const onTick = options && typeof options.onTick === "function" ? options.onTick : null;

  const thresholdMb = Number(runtimeConfig.asyncThresholdMb || DEFAULT_RUNTIME_CONFIG.asyncThresholdMb || 8);
  const thresholdBytes = thresholdMb * 1024 * 1024;
  const shouldUseAsync = asyncEndpoint && fileSizeBytes > thresholdBytes;

  if (shouldUseAsync) {
    if (runtimeUi) {
      runtimeUi.setStatus(asyncLabel, false);
    }
    const flow = await runJobFlow({
      startJob: () => startAsyncJob({ endpoint: asyncEndpoint, formData }),
      onTick,
      fallbackName,
      runtimeUi,
    });
    return flow.result;
  }

  if (runtimeUi) {
    runtimeUi.setStatus(syncLabel, false);
  }
  return submitFileTool({
    endpoint: syncEndpoint,
    formData,
    fallbackName,
  });
}

window.ToolspageApi = {
  trackEvent,
  getApiBase,
  buildApiUrl,
  setStatus,
  getRuntimeConfig,
  submitFileTool,
  startAsyncJob,
  startJsonJob,
  waitForJob,
  downloadJobResult,
  renderDownloadResult,
  createToolRuntime,
  runJobFlow,
  submitWithAutoAsync,
};
