// WoVoice landing page interactions. Loaded as a file because the site CSP forbids inline scripts.
(() => {
  document.documentElement.classList.add("js");
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Sticky nav gets a hairline once the page scrolls.
  const nav = document.querySelector(".nav");
  const onScroll = () => nav?.classList.toggle("is-scrolled", window.scrollY > 8);
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  // Promote the download button that matches the visitor's device.
  const agent = navigator.userAgent;
  const platform = /Android/i.test(agent) ? "android" : /Macintosh|Mac OS X/i.test(agent) && !/iPhone|iPad/i.test(agent) ? "mac" : null;
  if (platform) {
    document.querySelectorAll("[data-downloads]").forEach((group) => {
      const match = group.querySelector(`[data-platform="${platform}"]`);
      if (!match) return;
      match.classList.add("is-primary");
      group.prepend(match);
    });
  }

  // Version labels come from the Worker, which follows the newest GitHub release.
  const versionLabels = document.querySelectorAll("[data-version]");
  if (versionLabels.length) {
    fetch("/download/latest.json")
      .then((response) => (response.ok ? response.json() : null))
      .then((latest) => {
        versionLabels.forEach((label) => {
          const version = latest?.[label.dataset.version]?.version;
          if (version) label.textContent = `Version ${version} · ${label.dataset.extension}`;
        });
      })
      .catch(() => {});
  }

  // Scroll reveal, staggered within each parent.
  const reveals = document.querySelectorAll(".reveal");
  reveals.forEach((element) => {
    const siblings = [...element.parentElement.children].filter((child) => child.classList.contains("reveal"));
    element.style.setProperty("--delay", `${Math.min(siblings.indexOf(element), 6) * 90}ms`);
  });
  const revealObserver = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      entry.target.classList.add("is-visible");
      revealObserver.unobserve(entry.target);
    });
  }, { threshold: 0.15, rootMargin: "0px 0px -40px 0px" });
  reveals.forEach((element) => revealObserver.observe(element));

  // Hero demo: speech is "heard" in the bubble, then polished text is typed into the message.
  const output = document.getElementById("demo-output");
  const bubble = document.getElementById("demo-bubble");
  const status = document.getElementById("demo-status");
  const heard = document.getElementById("demo-heard");
  const examples = [
    { said: "can we meet tomorrow morning", text: "Can we meet tomorrow morning?" },
    {
      said: "hi priya um the invoice number is four eight two nine new line i'll send it today",
      text: "Hi Priya, the invoice number is 4829.\nI'll send it today.",
    },
    {
      said: "thanks for the update new paragraph let's discuss it on friday",
      text: "Thanks for the update.\n\nLet's discuss it on Friday.",
    },
  ];
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function typeWords(text, target, perWordMs) {
    const parts = text.split(/(\s+)/);
    for (const part of parts) {
      if (!part) continue;
      const span = document.createElement("span");
      span.className = "fresh";
      span.textContent = part;
      target.append(span);
      if (part.trim()) await wait(perWordMs);
    }
  }

  async function runDemo() {
    if (!output || !bubble) return;
    if (reduceMotion) {
      output.textContent = examples[0].text;
      bubble.dataset.state = "done";
      status.textContent = "Inserted";
      heard.textContent = `“${examples[0].said}”`;
      return;
    }
    for (let index = 0; ; index = (index + 1) % examples.length) {
      const example = examples[index];
      output.textContent = "";
      heard.textContent = "“";
      status.textContent = "Listening…";
      bubble.dataset.state = "listening";
      await wait(500);
      const words = example.said.split(" ");
      for (const word of words) {
        heard.textContent = `${heard.textContent === "“" ? "“" : `${heard.textContent} `}${word}`.replace("“ ", "“");
        await wait(170);
      }
      heard.textContent += "”";
      await wait(450);
      bubble.dataset.state = "working";
      status.textContent = "Transcribing…";
      await wait(1100);
      bubble.dataset.state = "done";
      status.textContent = "Inserted";
      await typeWords(example.text, output, 70);
      await wait(1400);
      bubble.dataset.state = "hidden";
      await wait(2600);
    }
  }
  runDemo();

  // Mac screenshots: tabs, with gentle auto-rotation until the visitor picks one.
  const tabs = [...document.querySelectorAll(".tabs [data-tab]")];
  const shots = [...document.querySelectorAll(".mac-frame [data-shot]")];
  let macTimer = null;
  function showShot(name) {
    tabs.forEach((tab) => tab.setAttribute("aria-selected", String(tab.dataset.tab === name)));
    shots.forEach((shot) => shot.classList.toggle("is-active", shot.dataset.shot === name));
  }
  tabs.forEach((tab) => tab.addEventListener("click", () => {
    clearInterval(macTimer);
    showShot(tab.dataset.tab);
  }));
  if (!reduceMotion && tabs.length) {
    let current = 0;
    macTimer = setInterval(() => {
      current = (current + 1) % tabs.length;
      showShot(tabs[current].dataset.tab);
    }, 5000);
  }

  // Subtle 3D tilt on the Mac window.
  const frame = document.querySelector("[data-tilt]");
  if (frame && !reduceMotion && window.matchMedia("(hover: hover)").matches) {
    frame.addEventListener("pointermove", (event) => {
      const box = frame.getBoundingClientRect();
      const x = (event.clientX - box.left) / box.width - 0.5;
      const y = (event.clientY - box.top) / box.height - 0.5;
      frame.style.setProperty("--ry", `${x * 8}deg`);
      frame.style.setProperty("--rx", `${-y * 6}deg`);
    });
    frame.addEventListener("pointerleave", () => {
      frame.style.setProperty("--ry", "0deg");
      frame.style.setProperty("--rx", "0deg");
    });
  }

  // Android phone carousel.
  const slides = [...document.querySelectorAll("[data-carousel] .slide")];
  const dots = [...document.querySelectorAll("[data-carousel-dots] i")];
  if (slides.length > 1 && !reduceMotion) {
    let slide = 0;
    setInterval(() => {
      slide = (slide + 1) % slides.length;
      slides.forEach((element, index) => element.classList.toggle("is-active", index === slide));
      dots.forEach((element, index) => element.classList.toggle("is-active", index === slide));
    }, 3600);
  }

  // Feature cards: a glow that follows the pointer.
  document.querySelectorAll("[data-glow]").forEach((card) => {
    card.addEventListener("pointermove", (event) => {
      const box = card.getBoundingClientRect();
      card.style.setProperty("--mx", `${event.clientX - box.left}px`);
      card.style.setProperty("--my", `${event.clientY - box.top}px`);
    });
  });

  // Count-up numbers.
  const counters = document.querySelectorAll("[data-count]");
  const format = new Intl.NumberFormat("en-IN");
  const countObserver = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      countObserver.unobserve(entry.target);
      const target = Number(entry.target.dataset.count);
      if (reduceMotion) {
        entry.target.textContent = format.format(target);
        return;
      }
      const started = performance.now();
      const duration = 1400;
      const tick = (now) => {
        const progress = Math.min(1, (now - started) / duration);
        const eased = 1 - (1 - progress) ** 3;
        entry.target.textContent = format.format(Math.round(target * eased));
        if (progress < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  }, { threshold: 0.6 });
  counters.forEach((counter) => countObserver.observe(counter));
})();
