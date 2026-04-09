const { spawn } = require("node:child_process");

async function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Request failed ${response.status}: ${url}`);
  }
  return response.json();
}

async function fetchText(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Request failed ${response.status}: ${url}`);
  }
  return response.text();
}

async function run() {
  const port = process.env.PORT || "8090";
  const child = spawn(process.execPath, ["server/index.js"], {
    env: {
      ...process.env,
      PORT: port,
      NODE_ENV: "test",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let started = false;
  child.stdout.on("data", (chunk) => {
    const line = chunk.toString("utf8");
    if (line.includes("Toolspage API started")) {
      started = true;
    }
  });

  child.stderr.on("data", (chunk) => {
    process.stderr.write(chunk.toString("utf8"));
  });

  try {
    for (let i = 0; i < 30; i += 1) {
      if (started) {
        break;
      }
      await wait(200);
    }

    const base = `http://127.0.0.1:${port}`;
    const status = await fetchJson(`${base}/api/v1/info/status`);
    if (status.status !== "UP") {
      throw new Error("Status endpoint did not return UP");
    }

    const config = await fetchJson(`${base}/api/v1/config`);
    if (!config.ok) {
      throw new Error("Config endpoint failed");
    }

    const metrics = await fetchText(`${base}/api/v1/metrics`);
    if (!metrics.includes("toolspage_uptime_seconds")) {
      throw new Error("Metrics endpoint missing expected payload");
    }

    console.log("Smoke checks passed");
  } finally {
    child.kill("SIGTERM");
  }
}

run().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
