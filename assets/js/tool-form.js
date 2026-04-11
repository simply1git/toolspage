function trackEvent(name, payload) {
  if (window.ToolspageApi && typeof window.ToolspageApi.trackEvent === "function") {
    window.ToolspageApi.trackEvent(name, payload);
    return;
  }
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
  current.push({
    name,
    payload,
    timestamp: new Date().toISOString(),
  });
  localStorage.setItem(key, JSON.stringify(current.slice(-400)));
}

function makeMockFileName(toolName, originalName) {
  const base = originalName.replace(/\.[^.]+$/, "") || "result";

  if (toolName === "PDF to Word") {
    return `${base}.docx`;
  }

  if (toolName === "Compress PDF") {
    return `${base}-compressed.pdf`;
  }

  if (toolName === "QR Generator") {
    return "toolspage-qr.png";
  }

  return `${base}-output`;
}

document.querySelectorAll("[data-tool-form]").forEach((form) => {
  const toolName = form.getAttribute("data-tool-name") || "Tool";
  trackEvent("tool_page_view", { toolName });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const resultBox = form.querySelector("[data-result]");
    const resultText = form.querySelector("[data-result-text]");
    const downloadLink = form.querySelector("[data-download-link]");
    const fileInput = form.querySelector('input[type="file"]');
    const contentInput = form.querySelector("textarea[name='content']");

    let sourceName = "output";
    if (fileInput && fileInput.files && fileInput.files[0]) {
      sourceName = fileInput.files[0].name;
      trackEvent("upload_started", { toolName, fileName: sourceName });
    }

    const outputName = makeMockFileName(toolName, sourceName);
    let href = "#";

    if (toolName === "QR Generator") {
      const text = encodeURIComponent((contentInput && contentInput.value.trim()) || "https://example.com");
      href = `https://quickchart.io/qr?size=500&text=${text}`;
    }

    if (resultText) {
      resultText.textContent = `${toolName} complete. Your file is ready: ${outputName}`;
    }

    if (downloadLink) {
      downloadLink.textContent = `Download ${outputName}`;
      downloadLink.setAttribute("download", outputName);
      downloadLink.setAttribute("href", href);
      downloadLink.addEventListener("click", () => {
        trackEvent("download_clicked", { toolName, outputName });
      }, { once: true });
    }

    if (resultBox) {
      resultBox.classList.remove("is-error");
      resultBox.classList.add("is-success");
      resultBox.hidden = false;
      if (window.playSuccessCue) {
        window.playSuccessCue();
      }
    }

    trackEvent("processing_succeeded", { toolName, outputName });
  });
});
