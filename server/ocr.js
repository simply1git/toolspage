const { FormData, Blob } = globalThis;

const LANG_MAP = {
  english: "eng",
  spanish: "spa",
  french: "fre",
  german: "ger",
};

async function ocrSpacePdf(fileBuffer, apiKey, language) {
  const form = new FormData();
  form.append("apikey", apiKey);
  form.append("language", language);
  form.append("isOverlayRequired", "false");
  form.append("file", new Blob([fileBuffer], { type: "application/pdf" }), "document.pdf");

  const response = await fetch("https://api.ocr.space/parse/image", {
    method: "POST",
    body: form,
  });

  if (!response.ok) {
    throw new Error(`OCR provider error (${response.status})`);
  }

  const data = await response.json();
  if (data.IsErroredOnProcessing) {
    throw new Error(data.ErrorMessage ? String(data.ErrorMessage) : "OCR processing failed");
  }

  const parsed = Array.isArray(data.ParsedResults) ? data.ParsedResults : [];
  const text = parsed.map((item) => item.ParsedText || "").join("\n").trim();
  return text;
}

async function extractPdfTextWithOcr(file, options, config) {
  const ocrModeOn = String(options.ocrMode || "off").toLowerCase() === "on";
  if (!ocrModeOn) {
    return "";
  }

  if (config.ocrProvider === "ocrspace" && config.ocrSpaceApiKey) {
    const language = String(options.language || "english").toLowerCase();
    const langCode = LANG_MAP[language] || "eng";
    return ocrSpacePdf(file.buffer, config.ocrSpaceApiKey, langCode);
  }

  const err = new Error("OCR mode requested but OCR provider is not configured");
  err.status = 422;
  throw err;
}

module.exports = {
  extractPdfTextWithOcr,
};
