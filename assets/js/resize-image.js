// Dedicated entrypoint for resize-image page.
// Core implementation lives in image-tools.js.
if (!window.__toolspageImageToolsLoaded) {
  window.__toolspageImageToolsLoaded = true;
  const script = document.createElement("script");
  script.src = "../assets/js/image-tools.js";
  script.defer = true;
  document.head.appendChild(script);
}
