// Particle background for extension Options page.
// Designed to be lightweight, DPR-aware, and safe for extension CSP (no inline scripts).

(() => {
  const CONFIG = {
    baseDensity: 0.15, // particles per 10,000 px^2 (higher = more particles)
    maxSpeed: 0.55, // px/frame at DPR=1
    radius: [1.0, 2.2],
    linkDist: 120,
    linkAlpha: 0.16,
    mouseInfluence: 120,
    repelStrength: 0.38,
    clickBurst: 120,
    colorParticle: "#c9e7ff",
    colorLink: "#7dd3fc",
  };

  function cssVar(name, fallback) {
    try {
      const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      return v || fallback;
    } catch {
      return fallback;
    }
  }

  function initColors() {
    // Use brand palette if present.
    const c1 = cssVar("--c1", "");
    const c3 = cssVar("--c3", "");
    if (c1) CONFIG.colorLink = c1;
    if (c3) CONFIG.colorParticle = c3;
  }

  const canvas = document.getElementById("pf-bg");
  if (!canvas) return;
  const ctx = canvas.getContext("2d", { alpha: true });
  if (!ctx) return;

  let DPR = 1;
  let W = 0;
  let H = 0;
  let raf = 0;
  let enabled = false;

  const mouse = { x: null, y: null };
  let particles = [];
  let targetCount = 0;

  const rand = (min, max) => Math.random() * (max - min) + min;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  class Particle {
    constructor() {
      this.reset(true);
    }
    reset(randomPos = false) {
      this.x = randomPos ? rand(0, W) : Math.random() < 0.5 ? 0 : W;
      this.y = randomPos ? rand(0, H) : rand(0, H);
      const ang = rand(0, Math.PI * 2);
      const speed = rand(0.05, CONFIG.maxSpeed);
      this.vx = Math.cos(ang) * speed;
      this.vy = Math.sin(ang) * speed;
      this.r = rand(CONFIG.radius[0], CONFIG.radius[1]) * DPR;
    }
    step(mx, my) {
      if (mx !== null && my !== null) {
        const dx = this.x - mx;
        const dy = this.y - my;
        const d2 = dx * dx + dy * dy;
        const r = CONFIG.mouseInfluence * DPR;
        if (d2 < r * r) {
          const d = Math.sqrt(d2) || 0.001;
          const ux = dx / d;
          const uy = dy / d;
          const strength = CONFIG.repelStrength;
          this.vx += ux * strength * (1 - d / r);
          this.vy += uy * strength * (1 - d / r);
        }
      }

      const sp = Math.hypot(this.vx, this.vy);
      const maxSp = CONFIG.maxSpeed;
      if (sp > maxSp) {
        this.vx *= maxSp / sp;
        this.vy *= maxSp / sp;
      }

      this.x += this.vx * DPR;
      this.y += this.vy * DPR;

      if (this.x < -50) this.x = W + 50;
      if (this.x > W + 50) this.x = -50;
      if (this.y < -50) this.y = H + 50;
      if (this.y > H + 50) this.y = -50;
    }
    draw() {
      ctx.beginPath();
      ctx.arc(this.x, this.y, this.r, 0, Math.PI * 2);
      ctx.fillStyle = CONFIG.colorParticle;
      ctx.globalAlpha = 0.9;
      ctx.fill();
    }
  }

  function computeParticlesCount() {
    const area = (W * H) / (DPR * DPR);
    const per10k = CONFIG.baseDensity;
    targetCount = Math.round(per10k * (area / 10000));
    targetCount = clamp(targetCount, 70, 320);
    if (particles.length < targetCount) {
      const add = targetCount - particles.length;
      for (let i = 0; i < add; i++) particles.push(new Particle());
    } else if (particles.length > targetCount) {
      particles.length = targetCount;
    }
  }

  function resize() {
    DPR = clamp(window.devicePixelRatio || 1, 1, 2);
    const cssW = Math.max(1, window.innerWidth);
    const cssH = Math.max(1, window.innerHeight);
    W = canvas.width = Math.floor(cssW * DPR);
    H = canvas.height = Math.floor(cssH * DPR);
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    computeParticlesCount();
  }

  function drawLinks() {
    ctx.lineWidth = 1 * DPR;
    ctx.strokeStyle = CONFIG.colorLink;
    for (let i = 0; i < particles.length; i++) {
      for (let j = i + 1; j < particles.length; j++) {
        const a = particles[i];
        const b = particles[j];
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const dist = Math.hypot(dx, dy);
        const maxD = CONFIG.linkDist * DPR;
        if (dist < maxD) {
          const alpha = CONFIG.linkAlpha * (1 - dist / maxD);
          ctx.globalAlpha = alpha;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }
    }
    ctx.globalAlpha = 1;
  }

  function loop() {
    if (!enabled) return;
    ctx.clearRect(0, 0, W, H);

    for (let i = 0; i < particles.length; i++) {
      particles[i].step(mouse.x, mouse.y);
    }
    drawLinks();
    for (let i = 0; i < particles.length; i++) {
      particles[i].draw();
    }

    raf = requestAnimationFrame(loop);
  }

  function setEnabled(next) {
    const want = Boolean(next);
    if (want === enabled) return;
    enabled = want;
    canvas.style.opacity = enabled ? "1" : "0";
    if (!enabled) {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      ctx.clearRect(0, 0, W, H);
      return;
    }
    resize();
    raf = requestAnimationFrame(loop);
  }

  // Events
  window.addEventListener(
    "mousemove",
    (e) => {
      mouse.x = e.clientX * DPR;
      mouse.y = e.clientY * DPR;
    },
    { passive: true }
  );
  window.addEventListener(
    "mouseleave",
    () => {
      mouse.x = null;
      mouse.y = null;
    },
    { passive: true }
  );
  window.addEventListener(
    "click",
    (e) => {
      if (!enabled) return;
      const mx = e.clientX * DPR;
      const my = e.clientY * DPR;
      const r = CONFIG.mouseInfluence * DPR;
      for (let i = 0; i < particles.length; i++) {
        const p = particles[i];
        const dx = p.x - mx;
        const dy = p.y - my;
        const d2 = dx * dx + dy * dy;
        if (d2 < r * r) {
          const d = Math.sqrt(d2) || 0.001;
          const ux = dx / d;
          const uy = dy / d;
          p.vx += ux * (CONFIG.clickBurst / 100);
          p.vy += uy * (CONFIG.clickBurst / 100);
        }
      }
    },
    { passive: true }
  );
  window.addEventListener("resize", () => enabled && resize(), { passive: true });

  // Init
  initColors();
  particles = [];
  for (let i = 0; i < 120; i++) particles.push(new Particle());
  resize();

  // Expose controller for options.js
  window.pfParticles = { setEnabled };

  // Default: OFF on Policy tab (options.js will manage afterwards too).
  setEnabled(false);
})();

