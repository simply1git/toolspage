const fs = require("node:fs/promises");
const path = require("node:path");
const { PDFDocument } = require("pdf-lib");
const { withTempFile, runCommand } = require("./security");

function getCompressionLevel(preset, quality) {
  if (preset === "100KB" || quality === "small") return 0.2;
  if (preset === "200KB" || quality === "balanced") return 0.5;
  if (preset === "500KB" || quality === "high") return 0.9;
  return 0.5;
}

async function compressWithPdfLib(file, options) {
  const inputPdf = await PDFDocument.load(file.buffer, { ignoreEncryption: true });
  const outputPdf = await PDFDocument.create();
  const pages = await outputPdf.copyPages(inputPdf, inputPdf.getPageIndices());
  pages.forEach((page) => outputPdf.addPage(page));

  const compressionLevel = getCompressionLevel(options.preset, options.quality);
  const useObjectStreams = compressionLevel >= 0.5;
  const compressed = await outputPdf.save({
    useObjectStreams,
    addDefaultPage: false,
    updateFieldAppearances: false,
  });

  const ratio = Number((compressed.length / file.buffer.length).toFixed(3));
  return {
    buffer: Buffer.from(compressed),
    method: "pdf-lib-rebuild",
    ratio,
  };
}

async function compressWithGhostscript(file, config) {
  return withTempFile(file.buffer, ".pdf", async (inputPath) => {
    const outputPath = path.join(path.dirname(inputPath), `${path.basename(inputPath, ".pdf")}-out.pdf`);
    const args = [
      "-sDEVICE=pdfwrite",
      "-dCompatibilityLevel=1.4",
      "-dPDFSETTINGS=/ebook",
      "-dNOPAUSE",
      "-dBATCH",
      `-sOutputFile=${outputPath}`,
      inputPath,
    ];

    await runCommand(config.ghostscriptCommand, args);
    const buffer = await fs.readFile(outputPath);
    await fs.unlink(outputPath).catch(() => {});

    const ratio = Number((buffer.length / file.buffer.length).toFixed(3));
    return {
      buffer,
      method: "ghostscript-ebook",
      ratio,
    };
  });
}

module.exports = {
  compressWithPdfLib,
  compressWithGhostscript,
};
