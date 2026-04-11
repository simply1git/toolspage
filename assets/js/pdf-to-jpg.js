const pdfToJpgForm = document.getElementById("pdfToJpgForm");

function clampPositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function resolvePageRange(totalPages, mode, startRaw, endRaw) {
  if (mode !== "range") {
    return {
      startPage: 1,
      endPage: totalPages,
      count: totalPages,
    };
  }

  const startPage = Math.max(1, Math.min(totalPages, clampPositiveInt(startRaw, 1)));
  const endPage = Math.max(1, Math.min(totalPages, clampPositiveInt(endRaw, totalPages)));

  if (startPage > endPage) {
    throw new Error("Invalid page range. Start page must be less than or equal to end page.");
  }

  return {
    startPage,
    endPage,
    count: (endPage - startPage) + 1,
  };
}

if (pdfToJpgForm) {
  const statusEl = document.getElementById("pdfToJpgStatus");
  const pageModeEl = document.getElementById("pdfPageMode");
  const pageRangeEl = document.getElementById("pdfPageRange");
  const startPageEl = document.getElementById("pdfStartPage");
  const endPageEl = document.getElementById("pdfEndPage");

  const syncPageScope = () => {
    const isRange = pageModeEl && pageModeEl.value === "range";
    if (pageRangeEl) {
      pageRangeEl.hidden = !isRange;
    }
  };

  if (pageModeEl) {
    pageModeEl.addEventListener("change", syncPageScope);
    syncPageScope();
  }

  pdfToJpgForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const file = document.getElementById("pdfToJpgFile").files[0];
    const scale = Number(document.getElementById("pdfRenderScale").value);

    if (!file) {
      return;
    }

    const resultBox = pdfToJpgForm.querySelector("[data-result]");
    const downloadLink = pdfToJpgForm.querySelector("[data-download-link]");
    const submitBtn = pdfToJpgForm.querySelector('button[type="submit"]');
    if (submitBtn) submitBtn.disabled = true;

    try {
      if (!window.pdfjsLib || typeof window.pdfjsLib.getDocument !== "function") {
        throw new Error("PDF engine failed to load. Refresh the page and try again.");
      }

      ToolspageApi.setStatus(statusEl, "Reading PDF pages...", false);

      const bytes = await file.arrayBuffer();
      const loadingTask = window.pdfjsLib.getDocument({ data: bytes });
      const pdf = await loadingTask.promise;
      const totalPages = Math.max(1, Number.parseInt(String(pdf.numPages || 1), 10));

      const pageMode = pageModeEl ? pageModeEl.value : "all";
      const { startPage, endPage, count } = resolvePageRange(
        totalPages,
        pageMode,
        startPageEl ? startPageEl.value : 1,
        endPageEl ? endPageEl.value : totalPages,
      );

      const runtime = await ToolspageApi.getRuntimeConfig();
      const thresholdMb = Number(runtime && runtime.asyncThresholdMb);
      const thresholdBytes = Number.isFinite(thresholdMb) && thresholdMb > 0
        ? thresholdMb * 1024 * 1024
        : (8 * 1024 * 1024);

      const forceBackend = count > 1 || file.size > thresholdBytes;

      if (forceBackend) {
        ToolspageApi.setStatus(statusEl, "Queuing multi-page conversion...", false);

        const formData = new FormData();
        formData.append("file", file);
        formData.append("qualityScale", String(scale));
        formData.append("pageMode", pageMode);
        formData.append("startPage", String(startPage));
        formData.append("endPage", String(endPage));

        const flow = await ToolspageApi.runJobFlow({
          startJob: () => ToolspageApi.startAsyncJob({
            endpoint: "/api/v1/jobs/pdf-to-jpg",
            formData,
          }),
          onTick: (tick) => {
            const phase = tick && tick.stage ? String(tick.stage).replace(/-/g, " ") : String(tick.status || "running");
            ToolspageApi.setStatus(statusEl, `Processing ${phase}...`, tick.status === "failed");
          },
          fallbackName: file.name.replace(/\.[^.]+$/, "") + "-pages.zip",
        });

        ToolspageApi.renderDownloadResult(
          pdfToJpgForm,
          count > 1 ? `Converted ${count} pages to JPG (ZIP).` : "Converted page to JPG.",
          flow.result.blob,
          flow.result.fileName,
        );
        ToolspageApi.setStatus(statusEl, "Done.", false);
        return;
      }

      ToolspageApi.setStatus(statusEl, "Rendering page in browser...", false);

      const page = await pdf.getPage(startPage);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d");

      if (!context) {
        throw new Error("Canvas rendering context unavailable.");
      }

      canvas.width = viewport.width;
      canvas.height = viewport.height;

      await page.render({ canvasContext: context, viewport }).promise;

      const blob = await new Promise((resolve) => canvas.toBlob((b) => resolve(b), "image/jpeg", 0.92));
      if (!blob) {
        throw new Error("Failed to render output image.");
      }

      const out = file.name.replace(/\.[^.]+$/, "") + `-page-${startPage}.jpg`;
      ToolspageApi.renderDownloadResult(pdfToJpgForm, "Converted selected page to JPG.", blob, out);
      ToolspageApi.setStatus(statusEl, "Done.", false);
    } catch (error) {
      ToolspageApi.setStatus(statusEl, error && error.message ? error.message : "Failed to convert PDF.", true);
      if (window.ToolspageApi && typeof window.ToolspageApi.renderResultMessage === "function") {
        window.ToolspageApi.renderResultMessage(
          pdfToJpgForm,
          error && error.message ? error.message : "Failed to convert PDF.",
          true,
        );
      } else if (resultBox) {
        resultBox.hidden = false;
        resultBox.classList.add("is-error");
        if (downloadLink) {
          downloadLink.hidden = true;
        }
      }
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  });
}
