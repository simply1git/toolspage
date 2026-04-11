const jpgToPdfForm = document.getElementById("jpgToPdfForm");

if (jpgToPdfForm) {
  jpgToPdfForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const files = Array.from(document.getElementById("jpgToPdfFile").files || []);
    if (!files.length) {
      return;
    }

    const resultBox = jpgToPdfForm.querySelector("[data-result]");
    const resultText = jpgToPdfForm.querySelector("[data-result-text]");
    const downloadLink = jpgToPdfForm.querySelector("[data-download-link]");
    const submitBtn = jpgToPdfForm.querySelector('button[type="submit"]');
    if (submitBtn) submitBtn.disabled = true;
    try {
      const { jsPDF } = window.jspdf;
      const doc = new jsPDF({ unit: "pt", format: "a4" });

      for (let i = 0; i < files.length; i += 1) {
        const file = files[i];
        const dataUrl = await new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.readAsDataURL(file);
        });

        const props = doc.getImageProperties(dataUrl);
        const pageWidth = doc.internal.pageSize.getWidth();
        const pageHeight = doc.internal.pageSize.getHeight();
        const ratio = Math.min(pageWidth / props.width, pageHeight / props.height);
        const w = props.width * ratio;
        const h = props.height * ratio;
        const x = (pageWidth - w) / 2;
        const y = (pageHeight - h) / 2;

        if (i > 0) {
          doc.addPage();
        }

        doc.addImage(dataUrl, "JPEG", x, y, w, h);
      }

      const blob = doc.output("blob");
      const out = "images-to-pdf.pdf";
      resultText.textContent = `Converted ${files.length} image(s) to PDF.`;
      if (downloadLink.dataset.objectUrl) {
        URL.revokeObjectURL(downloadLink.dataset.objectUrl);
      }
      const objectUrl = URL.createObjectURL(blob);
      downloadLink.dataset.objectUrl = objectUrl;
      downloadLink.href = objectUrl;
      downloadLink.download = out;
      downloadLink.textContent = `Download ${out}`;
      downloadLink.hidden = false;
      resultBox.classList.remove("is-error");
      resultBox.classList.add("is-success");
      resultBox.hidden = false;
    } catch (error) {
      if (resultText) {
        resultText.textContent = error && error.message ? error.message : "Failed to convert images.";
      }
      if (downloadLink) {
        downloadLink.hidden = true;
        downloadLink.removeAttribute("href");
      }
      if (resultBox) {
        resultBox.classList.remove("is-success");
        resultBox.classList.add("is-error");
        resultBox.hidden = false;
      }
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  });
}
