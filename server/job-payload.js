function buildQueuedFilePayload(file, options) {
  return {
    fileName: file ? file.originalname : "unknown.bin",
    mimeType: file ? file.mimetype : "application/octet-stream",
    fileBufferBase64: file ? file.buffer.toString("base64") : "",
    options,
  };
}

function parseQueuedFilePayload(payload) {
  if (!payload || !payload.fileBufferBase64) {
    const err = new Error("Queued payload is missing file data");
    err.status = 400;
    throw err;
  }

  return {
    originalname: payload.fileName || "document.bin",
    mimetype: payload.mimeType || "application/octet-stream",
    buffer: Buffer.from(payload.fileBufferBase64, "base64"),
  };
}

module.exports = {
  buildQueuedFilePayload,
  parseQueuedFilePayload,
};
