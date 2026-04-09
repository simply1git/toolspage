function setResult(form, message, blob, fileName) {
  const resultBox = form.querySelector("[data-result]");
  const resultText = form.querySelector("[data-result-text]");
  const downloadLink = form.querySelector("[data-download-link]");

  if (!resultBox || !resultText || !downloadLink) {
    return;
  }

  if (downloadLink.dataset.objectUrl) {
    URL.revokeObjectURL(downloadLink.dataset.objectUrl);
  }
  const href = URL.createObjectURL(blob);
  resultText.textContent = message;
  downloadLink.dataset.objectUrl = href;
  downloadLink.href = href;
  downloadLink.download = fileName;
  downloadLink.textContent = `Download ${fileName}`;
  resultBox.hidden = false;
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);

    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };

    img.onerror = () => reject(new Error("Could not load image."));
    img.src = url;
  });
}

async function imageToBlob(img, width, height, mime, quality) {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  canvas.width = width;
  canvas.height = height;
  ctx.drawImage(img, 0, 0, width, height);

  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), mime, quality);
  });
}

const compressForm = document.getElementById("compressImageForm");
if (compressForm) {
  compressForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const file = document.getElementById("compressImageFile").files[0];
    const quality = Number(document.getElementById("compressQuality").value) / 100;

    if (!file) {
      return;
    }
    const submitBtn = compressForm.querySelector('button[type="submit"]');
    if (submitBtn) submitBtn.disabled = true;
    try {
      const img = await loadImage(file);
      const blob = await imageToBlob(img, img.width, img.height, "image/jpeg", quality);
      const out = file.name.replace(/\.[^.]+$/, "") + "-compressed.jpg";
      setResult(compressForm, `Compression complete (${Math.round(quality * 100)}% quality).`, blob, out);
    } catch (error) {
      const resultBox = compressForm.querySelector("[data-result]");
      const resultText = compressForm.querySelector("[data-result-text]");
      if (resultText) resultText.textContent = error && error.message ? error.message : "Failed to compress image.";
      if (resultBox) resultBox.hidden = false;
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  });
}

const resizeForm = document.getElementById("resizeImageForm");
if (resizeForm) {
  resizeForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const file = document.getElementById("resizeImageFile").files[0];
    const width = Number(document.getElementById("resizeWidth").value);
    const height = Number(document.getElementById("resizeHeight").value);

    if (!file || !width || !height) {
      return;
    }
    const submitBtn = resizeForm.querySelector('button[type="submit"]');
    if (submitBtn) submitBtn.disabled = true;
    try {
      const img = await loadImage(file);
      const blob = await imageToBlob(img, width, height, "image/png", 1);
      const out = file.name.replace(/\.[^.]+$/, "") + `-${width}x${height}.png`;
      setResult(resizeForm, `Resize complete (${width}x${height}).`, blob, out);
    } catch (error) {
      const resultBox = resizeForm.querySelector("[data-result]");
      const resultText = resizeForm.querySelector("[data-result-text]");
      if (resultText) resultText.textContent = error && error.message ? error.message : "Failed to resize image.";
      if (resultBox) resultBox.hidden = false;
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  });
}

const removeBgForm = document.getElementById("removeBgForm");
if (removeBgForm) {
  removeBgForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const file = document.getElementById("removeBgFile").files[0];
    const threshold = Number(document.getElementById("removeBgThreshold").value);

    if (!file) {
      return;
    }
    const submitBtn = removeBgForm.querySelector('button[type="submit"]');
    if (submitBtn) submitBtn.disabled = true;
    try {
      const img = await loadImage(file);
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      canvas.width = img.width;
      canvas.height = img.height;
      ctx.drawImage(img, 0, 0);

      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const d = imageData.data;

      const r0 = d[0];
      const g0 = d[1];
      const b0 = d[2];

      for (let i = 0; i < d.length; i += 4) {
        const dr = d[i] - r0;
        const dg = d[i + 1] - g0;
        const db = d[i + 2] - b0;
        const distance = Math.sqrt(dr * dr + dg * dg + db * db);

        if (distance < threshold) {
          d[i + 3] = 0;
        }
      }

      ctx.putImageData(imageData, 0, 0);
      const blob = await new Promise((resolve) => canvas.toBlob((b) => resolve(b), "image/png", 1));
      const out = file.name.replace(/\.[^.]+$/, "") + "-nobg.png";
      setResult(removeBgForm, "Background removal complete (edge-color heuristic).", blob, out);
    } catch (error) {
      const resultBox = removeBgForm.querySelector("[data-result]");
      const resultText = removeBgForm.querySelector("[data-result-text]");
      if (resultText) resultText.textContent = error && error.message ? error.message : "Failed to remove background.";
      if (resultBox) resultBox.hidden = false;
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  });
}
