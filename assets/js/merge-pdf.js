const mergePdfForm = document.getElementById("mergePdfForm");

if (mergePdfForm) {
  mergePdfForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const files = Array.from(document.getElementById("mergePdfFile").files || []);
    if (!files.length) {
      return;
    }

    const resultBox = mergePdfForm.querySelector("[data-result]");
    const resultText = mergePdfForm.querySelector("[data-result-text]");
    const downloadLink = mergePdfForm.querySelector("[data-download-link]");
    const submitBtn = mergePdfForm.querySelector('button[type="submit"]');
    if (submitBtn) submitBtn.disabled = true;
    try {
      const outPdf = await PDFLib.PDFDocument.create();

      for (const file of files) {
        const srcBytes = await file.arrayBuffer();
        const srcPdf = await PDFLib.PDFDocument.load(srcBytes);
        const pages = await outPdf.copyPages(srcPdf, srcPdf.getPageIndices());
        pages.forEach((page) => outPdf.addPage(page));
      }

      const mergedBytes = await outPdf.save();
      const blob = new Blob([mergedBytes], { type: "application/pdf" });
      const out = "merged.pdf";
      resultText.textContent = `Merged ${files.length} PDF file(s).`;
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
        resultText.textContent = error && error.message ? error.message : "Failed to merge PDF files.";
      }
      if (resultBox) {
        resultBox.hidden = false;
      }
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  });
}
