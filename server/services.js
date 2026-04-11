const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const JSZip = require("jszip");
const pdfParse = require("pdf-parse");
const { Document, Packer, Paragraph } = require("docx");
const { extractPdfTextWithOcr } = require("./ocr");
const { runCommand, scanFileBuffer } = require("./security");
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

function sanitizeBaseName(name) {
  return String(name || "document")
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-zA-Z0-9-_]+/g, "-")
    .replace(/^-+|-+$/g, "") || "document";
}

function toSafeInt(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function resolvePageRange(options, totalPages) {
  const mode = String(options && options.pageMode || "all").toLowerCase();
  const startRaw = toSafeInt(options && options.startPage, 1);
  const endRaw = toSafeInt(options && options.endPage, totalPages);
  let startPage = Math.max(1, Math.min(totalPages, startRaw));
  let endPage = Math.max(1, Math.min(totalPages, endRaw));

  if (mode !== "range") {
    startPage = 1;
    endPage = totalPages;
  }

  if (startPage > endPage) {
    const err = new Error("Invalid page range. Start page must be less than or equal to end page.");
    err.status = 400;
    throw err;
  }

  return { startPage, endPage };
}

function qualityScaleToDpi(options) {
  const scale = Number.parseFloat(String(options && options.qualityScale || "1.8"));
  const normalized = Number.isFinite(scale) ? Math.min(3, Math.max(1, scale)) : 1.8;
  return Math.round(normalized * 100);
}

async function convertPdfToJpg(file, options, config) {
  assertPdf(file);
  await scanFileBuffer(file.buffer, config || {});

  let pdfInfo;
  try {
    pdfInfo = await pdfParse(file.buffer);
  } catch (_error) {
    const err = new Error("Could not parse PDF. The file may be encrypted or corrupted.");
    err.status = 422;
    throw err;
  }

  const totalPages = Math.max(1, Number.parseInt(String(pdfInfo.numpages || 1), 10));
  const { startPage, endPage } = resolvePageRange(options || {}, totalPages);
  const dpi = qualityScaleToDpi(options || {});
  const baseName = sanitizeBaseName(file.originalname);

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "toolspage-pdf2jpg-"));
  const inputPath = path.join(workDir, `input-${crypto.randomUUID()}.pdf`);
  const outputPattern = path.join(workDir, "page-%03d.jpg");

  try {
    await fs.writeFile(inputPath, file.buffer);

    const gsArgs = [
      "-dSAFER",
      "-dBATCH",
      "-dNOPAUSE",
      "-sDEVICE=jpeg",
      "-dJPEGQ=92",
      `-r${dpi}`,
      `-dFirstPage=${startPage}`,
      `-dLastPage=${endPage}`,
      `-sOutputFile=${outputPattern}`,
      inputPath,
    ];

    try {
      await runCommand(config.ghostscriptCommand, gsArgs);
    } catch (_error) {
      const err = new Error("PDF to JPG conversion failed.");
      err.status = 422;
      throw err;
    }

    const entries = await fs.readdir(workDir);
    const jpgFiles = entries
      .filter((name) => /^page-\d+\.jpg$/i.test(name))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

    if (!jpgFiles.length) {
      const err = new Error("No JPG output was generated from the PDF.");
      err.status = 422;
      throw err;
    }

    if (jpgFiles.length === 1) {
      const outputName = `${baseName}-page-${startPage}.jpg`;
      const buffer = await fs.readFile(path.join(workDir, jpgFiles[0]));
      return {
        buffer,
        outputName,
        contentType: "image/jpeg",
        stats: {
          method: "ghostscript-jpeg",
          totalPages,
          convertedPages: 1,
          pageRange: `${startPage}-${endPage}`,
        },
      };
    }

    const zip = new JSZip();
    const manifest = [];
    let pageCursor = startPage;
    for (const jpg of jpgFiles) {
      const data = await fs.readFile(path.join(workDir, jpg));
      const outputName = `${baseName}-page-${pageCursor}.jpg`;
      zip.file(outputName, data);
      manifest.push({ fileName: outputName, sizeBytes: data.length, page: pageCursor });
      pageCursor += 1;
    }

    zip.file("manifest.json", JSON.stringify({
      source: file.originalname || "document.pdf",
      totalPages,
      startPage,
      endPage,
      fileCount: manifest.length,
      files: manifest,
      createdAt: new Date().toISOString(),
    }, null, 2));

    const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    return {
      buffer,
      outputName: `${baseName}-pages-${startPage}-${endPage}.zip`,
      contentType: "application/zip",
      stats: {
        method: "ghostscript-jpeg-zip",
        totalPages,
        convertedPages: manifest.length,
        pageRange: `${startPage}-${endPage}`,
      },
    };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = {
  convertPdfToDocx,
  compressPdf,
  convertPdfToJpg,
};
