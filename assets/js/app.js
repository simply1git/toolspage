/**
 * Toolspage Premium Application Logic
 */

const initTheme = () => {
  const themeToggle = document.getElementById("themeToggle");
  const html = document.documentElement;
  let savedTheme = "light";
  try {
    savedTheme = localStorage.getItem("toolspage_theme") || (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  } catch (_err) {
    savedTheme = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  const setTheme = (theme) => {
    html.setAttribute("data-theme", theme);
    try {
      localStorage.setItem("toolspage_theme", theme);
    } catch (_err) {}
  };

  setTheme(savedTheme);

  if (themeToggle) {
    themeToggle.setAttribute("aria-pressed", savedTheme === "dark" ? "true" : "false");
    themeToggle.addEventListener("click", () => {
      const current = html.getAttribute("data-theme");
      const next = current === "dark" ? "light" : "dark";
      setTheme(next);
      themeToggle.setAttribute("aria-pressed", next === "dark" ? "true" : "false");
    });
  }
};

const initNavigation = () => {
  const menuBtn = document.getElementById("menuBtn");
  const mainNav = document.getElementById("mainNav");

  if (menuBtn && mainNav) {
    menuBtn.setAttribute("aria-controls", "mainNav");
    menuBtn.setAttribute("aria-expanded", "false");

    const setNavOpen = (open) => {
      mainNav.classList.toggle("open", open);
      menuBtn.classList.toggle("active", open);
      menuBtn.setAttribute("aria-expanded", open ? "true" : "false");
    };

    menuBtn.addEventListener("click", () => {
      const open = !mainNav.classList.contains("open");
      setNavOpen(open);
    });

    mainNav.querySelectorAll("a").forEach((link) => {
      link.addEventListener("click", () => {
        setNavOpen(false);
      });
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        setNavOpen(false);
      }
    });
  }
};

const initRevealAnimations = () => {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    document.querySelectorAll(".reveal").forEach((el) => el.classList.add("revealed"));
    return;
  }
  const observerOptions = {
    threshold: 0.1,
    rootMargin: "0px 0px -50px 0px",
  };

  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add("revealed");
        observer.unobserve(entry.target);
      }
    });
  }, observerOptions);

  document.querySelectorAll(".reveal").forEach((el) => observer.observe(el));
};

const initSkipLink = () => {
  const main = document.querySelector("main");
  if (!main || document.querySelector(".skip-link")) {
    return;
  }
  if (!main.id) {
    main.id = "mainContent";
  }
  const link = document.createElement("a");
  link.className = "skip-link";
  link.href = `#${main.id}`;
  link.textContent = "Skip to main content";
  document.body.prepend(link);
};

const initMagneticCards = () => {
  const cards = document.querySelectorAll(".tool-card");
  
  cards.forEach(card => {
    card.addEventListener("mousemove", (e) => {
      const rect = card.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      
      const centerX = rect.width / 2;
      const centerY = rect.height / 2;
      
      const rotateX = (y - centerY) / 20;
      const rotateY = (centerX - x) / 20;
      
      card.style.setProperty("--x", `${x}px`);
      card.style.setProperty("--y", `${y}px`);
      card.style.transform = `perspective(1000px) rotateX(${rotateX}deg) rotateY(${rotateY}deg) translateY(-8px) scale(1.02)`;
    });
    
    card.addEventListener("mouseleave", () => {
      card.style.transform = `perspective(1000px) rotateX(0) rotateY(0) translateY(0) scale(1)`;
    });
  });
};

const initPWA = () => {
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js").then(reg => {
        console.log("[PWA] Service Worker registered:", reg.scope);
      }).catch(err => {
        console.warn("[PWA] Service Worker registration failed:", err);
      });
    });
  }
};

const initSharedFileLoader = async () => {
  if (window.location.search.includes("shared=1")) {
    try {
      const shareCache = await caches.open("toolspage-share");
      const res = await shareCache.match("/shared-file");
      if (res) {
        const fileInput = document.querySelector('input[type="file"]');
        if (fileInput) {
          const blob = await res.blob();
          const fileName = res.headers.get("X-Original-Name") || "shared_file";
          const dataTransfer = new DataTransfer();
          dataTransfer.items.add(new File([blob], fileName, { type: blob.type }));
          fileInput.files = dataTransfer.files;
        }
        await shareCache.delete("/shared-file");
      }
    } catch(err) {
      console.warn("[PWA] Failed to mount shared file:", err);
    }
  }
};

const initEliteCues = () => {
  window.playSuccessCue = () => {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      
      osc.connect(gain);
      gain.connect(ctx.destination);
      
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(1760, ctx.currentTime + 0.1);
      
      gain.gain.setValueAtTime(0, ctx.currentTime);
      gain.gain.linearRampToValueAtTime(0.1, ctx.currentTime + 0.05);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
      
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.5);
    } catch (e) {
      console.warn('Audio cue failed', e);
    }
  };
};

// Orchestrate
document.addEventListener("DOMContentLoaded", () => {
  initTheme();
  initSkipLink();
  initNavigation();
  initRevealAnimations();
  initMagneticCards();
  initPWA();
  initEliteCues();
  initSharedFileLoader();
});
