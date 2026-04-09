const pdfToJpgForm = document.getElementById("pdfToJpgForm");

if (pdfToJpgForm) {
  pdfToJpgForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const file = document.getElementById("pdfToJpgFile").files[0];
    const scale = Number(document.getElementById("pdfRenderScale").value);

    if (!file) {
      return;
    }

    const resultBox = pdfToJpgForm.querySelector("[data-result]");
    const resultText = pdfToJpgForm.querySelector("[data-result-text]");
    const downloadLink = pdfToJpgForm.querySelector("[data-download-link]");
    const submitBtn = pdfToJpgForm.querySelector('button[type="submit"]');
    if (submitBtn) submitBtn.disabled = true;
    try {
      const bytes = await file.arrayBuffer();
      const loadingTask = window.pdfjsLib.getDocument({ data: bytes });
      const pdf = await loadingTask.promise;
      const page = await pdf.getPage(1);

      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d");
      canvas.width = viewport.width;
      canvas.height = viewport.height;

      await page.render({ canvasContext: context, viewport }).promise;

      const blob = await new Promise((resolve) => canvas.toBlob((b) => resolve(b), "image/jpeg", 0.92));
      if (!blob) {
        throw new Error("Failed to render output image.");
      }
      const out = file.name.replace(/\.[^.]+$/, "") + "-page-1.jpg";

      resultText.textContent = "Converted first page to JPG.";
      if (downloadLink.dataset.objectUrl) {
        URL.revokeObjectURL(downloadLink.dataset.objectUrl);
      }
      const objectUrl = URL.createObjectURL(blob);
      downloadLink.dataset.objectUrl = objectUrl;
      downloadLink.href = objectUrl;
      downloadLink.download = out;
      downloadLink.textContent = `Download ${out}`;
      resultBox.hidden = false;
    } catch (error) {
      if (resultText) {
        resultText.textContent = error && error.message ? error.message : "Failed to convert PDF.";
      }
      if (resultBox) {
        resultBox.hidden = false;
      }
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  });
}
