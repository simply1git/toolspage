// Dedicated entrypoint for Pinterest downloader page.
// Shared implementation lives in platform-downloader.js.
if (!window.__toolspagePlatformDownloaderLoaded) {
  window.__toolspagePlatformDownloaderLoaded = true;
  const script = document.createElement("script");
  script.src = "../assets/js/platform-downloader.js";
  script.defer = true;
  document.head.appendChild(script);
}
