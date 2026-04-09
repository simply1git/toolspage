const wordToPdfForm = document.getElementById("wordToPdfForm");

if (wordToPdfForm) {
  wordToPdfForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const file = document.getElementById("wordToPdfFile").files[0];
    if (!file) {
      return;
    }

    const resultBox = wordToPdfForm.querySelector("[data-result]");
    const resultText = wordToPdfForm.querySelector("[data-result-text]");
    const downloadLink = wordToPdfForm.querySelector("[data-download-link]");
    const submitBtn = wordToPdfForm.querySelector('button[type="submit"]');
    if (submitBtn) submitBtn.disabled = true;
    try {
      const arrayBuffer = await file.arrayBuffer();
      const textResult = await window.mammoth.extractRawText({ arrayBuffer });
      const content = textResult.value || "";

      const { jsPDF } = window.jspdf;
      const doc = new jsPDF({ unit: "pt", format: "a4" });
      const left = 40;
      const top = 50;
      const maxWidth = doc.internal.pageSize.getWidth() - 80;
      const lines = doc.splitTextToSize(content, maxWidth);

      let y = top;
      lines.forEach((line) => {
        if (y > doc.internal.pageSize.getHeight() - 40) {
          doc.addPage();
          y = top;
        }
        doc.text(line, left, y);
        y += 16;
      });

      const blob = doc.output("blob");
      const out = file.name.replace(/\.[^.]+$/, "") + ".pdf";

      resultText.textContent = "Converted DOCX text to PDF.";
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
        resultText.textContent = error && error.message ? error.message : "Failed to convert DOCX.";
      }
      if (resultBox) {
        resultBox.hidden = false;
      }
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  });
}
