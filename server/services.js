const pdfParse = require("pdf-parse");
const { Document, Packer, Paragraph } = require("docx");
const { extractPdfTextWithOcr } = require("./ocr");
const { scanFileBuffer } = require("./security");
const { compressWithPdfLib, compressWithGhostscript } = require("./compression");

const LANG_MAP = {
  english: "en-US",
  spanish: "es-ES",
  french: "fr-FR",
  german: "de-DE",
};

function assertPdf(file) {
  if (!file) {
    const err = new Error("No file provided");
    err.status = 400;
    throw err;
  }

  const isPdfMime = file.mimetype === "application/pdf";
  const isPdfName = /\.pdf$/i.test(file.originalname || "");
  const hasPdfSignature =
    Buffer.isBuffer(file.buffer) &&
    file.buffer.length >= 4 &&
    file.buffer[0] === 0x25 &&
    file.buffer[1] === 0x50 &&
    file.buffer[2] === 0x44 &&
    file.buffer[3] === 0x46;

  if ((!isPdfMime && !isPdfName) || !hasPdfSignature) {
    const err = new Error("Only PDF files are supported");
    err.status = 415;
    throw err;
  }
}

async function convertPdfToDocx(file, options, config) {
  assertPdf(file);
  await scanFileBuffer(file.buffer, config || {});

  let data;
  try {
    data = await pdfParse(file.buffer);
  } catch (error) {
    const err = new Error("Could not parse PDF. The file may be encrypted or corrupted.");
    err.status = 422;
    throw err;
  }
  let normalized = (data.text || "").replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    normalized = await extractPdfTextWithOcr(file, options || {}, config || {});
  }

  if (!normalized) {
    const err = new Error("No extractable text found in PDF. Use OCR pipeline for scanned files.");
    err.status = 422;
    throw err;
  }

  const locale = LANG_MAP[String(options.language || "english").toLowerCase()] || "en-US";
  const lines = normalized.split("\n");
  const children = lines.map((line) => new Paragraph({ text: line || " " }));

  const doc = new Document({
    sections: [{ children }],
    features: {
      updateFields: false,
    },
    styles: {
      default: {
        heading1: { run: { size: 34, bold: true } },
        document: { run: { font: "Calibri", size: 22, lang: locale } },
      },
    },
  });

  const buffer = await Packer.toBuffer(doc);
  const outputName = (file.originalname || "document.pdf").replace(/\.pdf$/i, "") + ".docx";

  return { buffer, outputName };
}

async function compressPdf(file, options, config) {
  assertPdf(file);
  await scanFileBuffer(file.buffer, config || {});

  let compressed;
  const engine = String((config && config.compressEngine) || "auto").toLowerCase();

  try {
    if (engine === "ghostscript") {
      compressed = await compressWithGhostscript(file, config || {});
    } else if (engine === "pdf-lib") {
      compressed = await compressWithPdfLib(file, options || {});
    } else {
      try {
        compressed = await compressWithGhostscript(file, config || {});
      } catch (_error) {
        compressed = await compressWithPdfLib(file, options || {});
      }
    }
  } catch (error) {
    const err = new Error("Could not compress PDF with configured engine.");
    err.status = 422;
    throw err;
  }

  const outputName = (file.originalname || "document.pdf").replace(/\.pdf$/i, "") + "-compressed.pdf";
  const ratio = Number((compressed.ratio || 1).toFixed(3));

  return {
    buffer: Buffer.from(compressed.buffer),
    outputName,
    stats: {
      inputBytes: file.buffer.length,
      outputBytes: compressed.buffer.length,
      ratio,
      method: compressed.method,
      note:
        ratio >= 1
          ? "Output was not smaller. Try higher compression profile or alternate engine."
          : "Compression successful.",
    },
  };
}

module.exports = {
  convertPdfToDocx,
  compressPdf,
};
