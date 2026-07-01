// NOTE: MediaPipe's package is an Emscripten UMD bundle that loads its own
// .wasm/.tflite/.data companion files at runtime, resolved relative to the
// location of selfie_segmentation.js. If we `import` it, Vite inlines the JS and
// Emscripten loses that script directory, so it requests the companions from the
// wrong path and the graph silently stalls. Loading it as a classic <script>
// from our self-hosted /mediapipe/ folder keeps that resolution correct.
const MP_BASE = `${import.meta.env.BASE_URL}mediapipe/`;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.crossOrigin = "anonymous";
    s.onload = resolve;
    s.onerror = () => reject(new Error("Failed to load " + src));
    document.head.appendChild(s);
  });
}

const video = document.getElementById("cam");
const canvas = document.getElementById("scene");
const ctx = canvas.getContext("2d", { alpha: false });
const overlay = document.getElementById("overlay");
const startBtn = document.getElementById("startBtn");
const statusEl = document.getElementById("status");
const fpsEl = document.getElementById("fps");

// Offscreen canvas to read the segmentation mask cheaply at low res.
const mask = document.createElement("canvas");
const mctx = mask.getContext("2d", { willReadFrequently: true });

// ---- Tunables ----
const CFG = {
  sampleW: 160, // mask sampling width (height derived from aspect)
  step: 5, // particle grid stride in mask pixels (smaller = denser)
  ease: 0.16, // how fast particles seek their target
  friction: 0.86, // velocity damping
  pointerRadius: 110,
  pointerForce: 2.6,
  maskThreshold: 0.5,
};

const PALETTES = [
  ["#7aa2ff", "#58e6c9", "#b388ff"],
  ["#ff8fab", "#ffd6a5", "#fdffb6"],
  ["#00f5d4", "#00bbf9", "#9b5de5"],
  ["#f15bb5", "#fee440", "#00bbf9"],
];

const state = {
  paletteIdx: 0,
  mirror: true,
  paused: false,
  running: false,
  pointer: { x: -1e6, y: -1e6, active: false },
  particles: [],
  cols: 0,
  rows: 0,
};

// ---------- Particle pool ----------
// One particle per grid cell. A cell that falls inside the silhouette pulls its
// particle "home" and lights it up; outside cells let it drift.
function buildParticles(mw, mh) {
  const parts = [];
  const cols = Math.floor(mw / CFG.step);
  const rows = Math.floor(mh / CFG.step);
  for (let gy = 0; gy < rows; gy++) {
    for (let gx = 0; gx < cols; gx++) {
      const mx = gx * CFG.step + CFG.step / 2;
      const my = gy * CFG.step + CFG.step / 2;
      parts.push({
        mx,
        my, // home position in mask space
        x: Math.random() * mw, // current position in mask space
        y: Math.random() * mh,
        vx: 0,
        vy: 0,
        life: 0, // 0..1 brightness, eased
      });
    }
  }
  state.cols = cols;
  state.rows = rows;
  state.particles = parts;
}

// ---------- Layout ----------
let scaleX = 1,
  scaleY = 1; // mask space -> canvas space
function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.floor(window.innerWidth * dpr);
  canvas.height = Math.floor(window.innerHeight * dpr);
  canvas.style.width = window.innerWidth + "px";
  canvas.style.height = window.innerHeight + "px";
  if (mask.width) {
    scaleX = canvas.width / mask.width;
    scaleY = canvas.height / mask.height;
  }
}
window.addEventListener("resize", resize);

// ---------- Pointer interaction ----------
function setPointer(e, active) {
  const dpr = canvas.width / window.innerWidth;
  const t = e.touches ? e.touches[0] : e;
  if (!t) return;
  state.pointer.x = t.clientX * dpr;
  state.pointer.y = t.clientY * dpr;
  state.pointer.active = active;
}
canvas.addEventListener("mousemove", (e) => setPointer(e, true));
canvas.addEventListener("mouseleave", () => (state.pointer.active = false));
canvas.addEventListener("touchstart", (e) => setPointer(e, true), { passive: true });
canvas.addEventListener("touchmove", (e) => setPointer(e, true), { passive: true });
canvas.addEventListener("touchend", () => (state.pointer.active = false));

// ---------- HUD ----------
document.getElementById("hud").addEventListener("click", (e) => {
  const action = e.target.dataset.action;
  if (action === "palette") state.paletteIdx = (state.paletteIdx + 1) % PALETTES.length;
  else if (action === "mirror") state.mirror = !state.mirror;
  else if (action === "explode") explode();
  else if (action === "pause") {
    state.paused = !state.paused;
    e.target.textContent = state.paused ? "▶ Resume" : "⏸ Pause";
  }
});

function explode() {
  for (const p of state.particles) {
    const a = Math.random() * Math.PI * 2;
    const s = 8 + Math.random() * 14;
    p.vx += Math.cos(a) * s;
    p.vy += Math.sin(a) * s;
  }
}

// ---------- Segmentation ----------
let latestMaskData = null;
let maskReady = false;

function onResults(results) {
  const seg = results.segmentationMask;
  if (!seg) return;
  if (!mask.width) {
    const aspect = seg.height / seg.width;
    mask.width = CFG.sampleW;
    mask.height = Math.round(CFG.sampleW * aspect);
    buildParticles(mask.width, mask.height);
    resize();
  }
  // Mirror horizontally so it reads like a mirror by default.
  mctx.save();
  mctx.clearRect(0, 0, mask.width, mask.height);
  if (state.mirror) {
    mctx.translate(mask.width, 0);
    mctx.scale(-1, 1);
  }
  mctx.drawImage(seg, 0, 0, mask.width, mask.height);
  mctx.restore();
  latestMaskData = mctx.getImageData(0, 0, mask.width, mask.height).data;
  maskReady = true;
}

let selfieSeg = null;
async function initSegmentation() {
  // Load the UMD as a classic script so Emscripten resolves its companion
  // assets relative to /mediapipe/ (see MP_BASE note at top of file).
  await loadScript(MP_BASE + "selfie_segmentation.js");
  selfieSeg = new window.SelfieSegmentation({
    locateFile: (f) => MP_BASE + f,
  });
  selfieSeg.setOptions({ modelSelection: 1 }); // 1 = general (full body)
  selfieSeg.onResults(onResults);
}

// ---------- Camera pump ----------
// We drive MediaPipe ourselves (instead of @mediapipe/camera_utils) to keep the
// dependency list small.
async function pumpCamera() {
  if (!state.paused && video.readyState >= 2) {
    try {
      await selfieSeg.send({ image: video });
    } catch (_) {}
  }
  requestAnimationFrame(pumpCamera);
}

// ---------- Render loop ----------
let lastT = performance.now();
let fpsSmooth = 0;
let prevFrameT = 0;

function maskValueAt(mx, my) {
  if (!latestMaskData) return 0;
  const ix = Math.max(0, Math.min(mask.width - 1, mx | 0));
  const iy = Math.max(0, Math.min(mask.height - 1, my | 0));
  // Mask is grayscale; red channel carries the person probability.
  return latestMaskData[(iy * mask.width + ix) * 4] / 255;
}

function render(now) {
  requestAnimationFrame(render);
  const dt = Math.min(2, (now - lastT) / 16.67);
  lastT = now;

  const fps = 1000 / Math.max(1, now - (prevFrameT || now));
  prevFrameT = now;
  fpsSmooth = fpsSmooth ? fpsSmooth * 0.9 + fps * 0.1 : fps;
  fpsEl.textContent = state.running ? Math.round(fpsSmooth) + " fps" : "";

  // Trail fade — gives particles a soft motion glow.
  ctx.fillStyle = "rgba(5, 6, 10, 0.28)";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  if (!maskReady || state.paused) return;

  const palette = PALETTES[state.paletteIdx];
  const px = state.pointer;
  const pr = CFG.pointerRadius * (canvas.width / window.innerWidth);

  ctx.globalCompositeOperation = "lighter";

  for (let i = 0; i < state.particles.length; i++) {
    const p = state.particles[i];
    const inside = maskValueAt(p.mx, p.my) > CFG.maskThreshold;

    // Brightness eases in/out so the body edge shimmers instead of snapping.
    p.life += ((inside ? 1 : 0) - p.life) * 0.12 * dt;

    // Seek home when inside; gently drift outward when not.
    if (inside) {
      p.vx += (p.mx - p.x) * CFG.ease * dt;
      p.vy += (p.my - p.y) * CFG.ease * dt;
    } else {
      p.vx += (Math.random() - 0.5) * 0.15 * dt;
      p.vy += (Math.random() - 0.5) * 0.15 * dt;
    }

    // Pointer repulsion (computed in canvas space).
    const cx = p.x * scaleX,
      cy = p.y * scaleY;
    if (px.active) {
      const dx = cx - px.x,
        dy = cy - px.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < pr * pr) {
        const d = Math.sqrt(d2) || 1;
        const f = (1 - d / pr) * CFG.pointerForce;
        p.vx += ((dx / d) * f) / scaleX * dt;
        p.vy += ((dy / d) * f) / scaleY * dt;
      }
    }

    p.vx *= CFG.friction;
    p.vy *= CFG.friction;
    p.x += p.vx * dt;
    p.y += p.vy * dt;

    if (p.life < 0.04) continue; // skip nearly-invisible particles

    const drawX = p.x * scaleX;
    const drawY = p.y * scaleY;
    const color = palette[i % palette.length];
    const r = (1.1 + p.life * 2.2) * (canvas.width / 1280) * 2;

    ctx.globalAlpha = Math.min(1, p.life);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(drawX, drawY, r, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
}

// ---------- Boot ----------
async function start() {
  startBtn.disabled = true;
  statusEl.style.color = "#aab2d8";
  statusEl.textContent = "Requesting camera…";
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();

    statusEl.textContent = "Loading segmentation model…";
    await initSegmentation();

    // Hand off immediately: the render loop guards on `maskReady`, so the UI
    // stays responsive and shows the scene even before the first mask arrives —
    // we never block the overlay on a frame that might stall.
    state.running = true;
    overlay.classList.add("hidden");
    pumpCamera();
    requestAnimationFrame(render);
  } catch (err) {
    startBtn.disabled = false;
    statusEl.style.color = "#ff9a9a";
    const name = err && err.name;
    if (name === "NotAllowedError")
      statusEl.textContent = "Camera permission denied. Allow access and try again.";
    else if (name === "NotFoundError")
      statusEl.textContent = "No camera found on this device.";
    else if (location.protocol === "file:")
      statusEl.textContent = "Run via `npm run dev` — file:// blocks the camera.";
    else statusEl.textContent = "Could not start camera: " + ((err && err.message) || err);
  }
}

startBtn.addEventListener("click", start);
resize();
