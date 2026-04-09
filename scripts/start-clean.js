const { execSync, spawn } = require("node:child_process");

function parsePort(value) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 8080;
}

function collectListeningPidsWindows(port) {
  try {
    const output = execSync(`netstat -ano -p tcp | findstr :${port}`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });

    const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const pids = new Set();

    for (const line of lines) {
      if (!/LISTENING/i.test(line)) {
        continue;
      }
      const parts = line.split(/\s+/);
      const pid = Number.parseInt(parts[parts.length - 1], 10);
      if (Number.isFinite(pid) && pid > 0 && pid !== process.pid) {
        pids.add(pid);
      }
    }

    return [...pids];
  } catch (_err) {
    return [];
  }
}

function killProcessWindows(pid) {
  try {
    execSync(`taskkill /PID ${pid} /F`, {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
    return true;
  } catch (_err) {
    return false;
  }
}

function killPortListeners(port) {
  if (process.platform !== "win32") {
    return [];
  }

  const pids = collectListeningPidsWindows(port);
  const killed = [];
  for (const pid of pids) {
    if (killProcessWindows(pid)) {
      killed.push(pid);
    }
  }
  return killed;
}

function startServer() {
  const child = spawn(process.execPath, ["server/index.js"], {
    stdio: "inherit",
    env: process.env,
  });

  const forwardSignal = (signal) => {
    if (!child.killed) {
      child.kill(signal);
    }
  };

  process.on("SIGINT", () => forwardSignal("SIGINT"));
  process.on("SIGTERM", () => forwardSignal("SIGTERM"));

  child.on("exit", (code, signal) => {
    if (signal) {
      process.exit(1);
      return;
    }
    process.exit(code || 0);
  });
}

(function main() {
  const port = parsePort(process.env.PORT || "8080");
  const killed = killPortListeners(port);

  if (killed.length > 0) {
    console.log(`[start:clean] Cleared port ${port}. Killed PID(s): ${killed.join(", ")}`);
  } else {
    console.log(`[start:clean] No conflicting listeners found on port ${port}.`);
  }

  console.log("[start:clean] Starting Toolspage API...");
  startServer();
})();
