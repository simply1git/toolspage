const thumbForm = document.getElementById("youtubeThumbnailForm");

if (thumbForm) {
  const sourceUrlEl = document.getElementById("thumbnailSourceUrl");
  const statusEl = document.getElementById("youtubeThumbnailStatus");
  const resultsEl = document.getElementById("thumbnailResults");

  ToolspageApi.trackEvent("tool_page_view", { toolName: "YouTube Thumbnail Downloader" });

  const variants = [
    { key: "maxresdefault", label: "Max Resolution" },
    { key: "sddefault", label: "Standard Definition" },
    { key: "hqdefault", label: "High Quality" },
    { key: "mqdefault", label: "Medium Quality" },
    { key: "default", label: "Default" },
  ];

  function parseVideoId(input) {
    const raw = String(input || "").trim();
    if (!raw) {
      return null;
    }

    if (/^[a-zA-Z0-9_-]{11}$/.test(raw)) {
      return raw;
    }

    try {
      const url = new URL(raw);
      const host = url.hostname.toLowerCase();

      if (host.includes("youtu.be")) {
        const id = url.pathname.split("/").filter(Boolean)[0] || "";
        return /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : null;
      }

      if (host.includes("youtube.com")) {
        const watchId = url.searchParams.get("v") || "";
        if (/^[a-zA-Z0-9_-]{11}$/.test(watchId)) {
          return watchId;
        }

        const parts = url.pathname.split("/").filter(Boolean);
        const shortsIndex = parts.indexOf("shorts");
        if (shortsIndex >= 0 && parts[shortsIndex + 1] && /^[a-zA-Z0-9_-]{11}$/.test(parts[shortsIndex + 1])) {
          return parts[shortsIndex + 1];
        }

        const embedIndex = parts.indexOf("embed");
        if (embedIndex >= 0 && parts[embedIndex + 1] && /^[a-zA-Z0-9_-]{11}$/.test(parts[embedIndex + 1])) {
          return parts[embedIndex + 1];
        }
      }
    } catch (_err) {
      return null;
    }

    return null;
  }

  function checkImage(url) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        resolve(img.naturalWidth > 0 && img.naturalHeight > 0 ? {
          ok: true,
          width: img.naturalWidth,
          height: img.naturalHeight,
        } : { ok: false });
      };
      img.onerror = () => resolve({ ok: false });
      img.src = url;
    });
  }

  function renderThumbnailCard(file) {
    const card = document.createElement("article");
    card.className = "tool-card";

    const title = document.createElement("h3");
    title.textContent = file.label;

    const image = document.createElement("img");
    image.src = file.url;
    image.alt = `${file.label} thumbnail preview`;
    image.loading = "lazy";
    image.style.width = "100%";
    image.style.borderRadius = "10px";
    image.style.border = "1px solid var(--line)";

    const meta = document.createElement("p");
    meta.textContent = `${file.width}x${file.height}`;

    const link = document.createElement("a");
    link.href = file.url;
    link.download = `${file.videoId}-${file.key}.jpg`;
    link.target = "_blank";
    link.rel = "noopener";
    link.className = "tool-link";
    link.textContent = `Download ${file.key}.jpg`;

    card.appendChild(title);
    card.appendChild(image);
    card.appendChild(meta);
    card.appendChild(link);
    return card;
  }

  thumbForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    resultsEl.innerHTML = "";

    const videoId = parseVideoId(sourceUrlEl.value);
    if (!videoId) {
      ToolspageApi.setStatus(statusEl, "Enter a valid YouTube URL or video ID.", true);
      return;
    }

    ToolspageApi.setStatus(statusEl, "Checking available thumbnail sizes...", false);

    const checks = await Promise.all(variants.map(async (variant) => {
      const url = `https://img.youtube.com/vi/${videoId}/${variant.key}.jpg`;
      const info = await checkImage(url);
      if (!info.ok) {
        return null;
      }
      return {
        ...variant,
        videoId,
        url,
        width: info.width,
        height: info.height,
      };
    }));

    const available = checks.filter(Boolean);
    if (available.length === 0) {
      ToolspageApi.setStatus(statusEl, "No thumbnails found for this video.", true);
      return;
    }

    for (const file of available) {
      resultsEl.appendChild(renderThumbnailCard(file));
    }

    ToolspageApi.setStatus(statusEl, `Found ${available.length} thumbnail size(s).`, false);
  });
}
