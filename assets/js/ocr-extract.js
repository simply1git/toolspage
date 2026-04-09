const ocrForm = document.getElementById("ocrExtractForm");

if (ocrForm) {
  ocrForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const file = document.getElementById("ocrFile").files[0];
    if (!file) {
      return;
    }

    const status = document.getElementById("ocrStatus");
    const resultBox = ocrForm.querySelector("[data-result]");
    const resultText = ocrForm.querySelector("[data-result-text]");
    const downloadLink = ocrForm.querySelector("[data-download-link]");
    const submitBtn = ocrForm.querySelector('button[type="submit"]');
    if (submitBtn) submitBtn.disabled = true;
    status.textContent = "Running OCR... this may take a while.";

    try {
      const result = await Tesseract.recognize(file, "eng", {
        logger: (m) => {
          if (m.status === "recognizing text") {
            status.textContent = `Running OCR... ${Math.round((m.progress || 0) * 100)}%`;
          }
        },
      });

      const text = result.data.text || "";
      const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
      const out = file.name.replace(/\.[^.]+$/, "") + "-ocr.txt";
      resultText.textContent = "OCR complete.";
      if (downloadLink.dataset.objectUrl) {
        URL.revokeObjectURL(downloadLink.dataset.objectUrl);
      }
      const objectUrl = URL.createObjectURL(blob);
      downloadLink.dataset.objectUrl = objectUrl;
      downloadLink.href = objectUrl;
      downloadLink.download = out;
      downloadLink.textContent = `Download ${out}`;
      resultBox.hidden = false;
      status.textContent = "OCR finished.";
    } catch (error) {
      status.textContent = error && error.message ? error.message : "OCR failed. Please try another file.";
      if (resultText) {
        resultText.textContent = "OCR failed.";
      }
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  });
}
