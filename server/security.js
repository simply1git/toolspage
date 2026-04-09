const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

async function withTempFile(buffer, suffix, action) {
  const filePath = path.join(os.tmpdir(), `toolspage-${crypto.randomUUID()}${suffix}`);
  await fs.writeFile(filePath, buffer);
  try {
    return await action(filePath);
  } finally {
    await fs.unlink(filePath).catch(() => {});
  }
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ code, stdout, stderr });
        return;
      }
      reject(new Error(stderr || `${command} exited with ${code}`));
    });
  });
}

async function scanFileBuffer(buffer, config) {
  if (!config.enableClamScan) {
    return;
  }

  await withTempFile(buffer, ".bin", async (filePath) => {
    try {
      await runCommand(config.clamscanCommand, ["--no-summary", filePath]);
    } catch (error) {
      const err = new Error("File security scan failed");
      err.status = 422;
      throw err;
    }
  });
}

module.exports = {
  withTempFile,
  runCommand,
  scanFileBuffer,
};
