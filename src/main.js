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
  sampleW: 180, // mask sampling width (height derived from aspect)
  step: 4, // particle grid stride in mask pixels (smaller = denser)
  ease: 0.16, // how fast particles gather into the silhouette
  ambientEase: 0.035, // how gently particles follow their organic drift
  ambientScatter: 4, // resting-position spread in mask px (breaks up the grid)
  ambientAmp: 2.6, // organic drift amplitude in mask px
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
// One particle per grid cell. The field is always alive: each particle drifts
// organically around a scattered resting spot, and gathers onto its crisp grid
// "home" (mx,my) only while that cell is inside the silhouette.
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
        my, // grid home (silhouette target) in mask space
        // Static scatter so the resting field looks organic, not a rigid grid.
        ox: (Math.random() - 0.5) * 2 * CFG.ambientScatter,
        oy: (Math.random() - 0.5) * 2 * CFG.ambientScatter,
        phase: Math.random() * Math.PI * 2, // desync the drift per particle
        x: mx,
        y: my,
        vx: 0,
        vy: 0,
        life: 0, // 0..1 "formed-ness", eased
      });
    }
  }
  state.cols = cols;
  state.rows = rows;
  state.particles = parts;
}

// ---------- Layout ----------
// Uniform "cover" mapping from mask space -> canvas space: one scale for both
// axes (so the silhouette keeps its proportions instead of stretching) plus a
// centering offset. Overflow is cropped, like CSS `object-fit: cover`.
let scale = 1,
  offX = 0,
  offY = 0;
// Explicit init flag: a fresh <canvas> defaults to width=300, so we can't use
// `mask.width` as the "not sized yet" sentinel — it would never be falsy and the
// particle grid would never get built.
let sized = false;
function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.floor(window.innerWidth * dpr);
  canvas.height = Math.floor(window.innerHeight * dpr);
  canvas.style.width = window.innerWidth + "px";
  canvas.style.height = window.innerHeight + "px";
  if (sized) {
    scale = Math.max(canvas.width / mask.width, canvas.height / mask.height);
    offX = (canvas.width - mask.width * scale) / 2;
    offY = (canvas.height - mask.height * scale) / 2;
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

function sizeMaskTo(aspect) {
  mask.width = CFG.sampleW;
  mask.height = Math.max(1, Math.round(CFG.sampleW * aspect));
  buildParticles(mask.width, mask.height);
  sized = true; // must precede resize() — it gates the scale calc on `sized`
  resize();
}

function onResults(results) {
  const seg = results.segmentationMask;
  if (!seg) return;
  if (!sized) sizeMaskTo(seg.height / seg.width);
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
let mpLoaded = false;
async function initSegmentation() {
  if (selfieSeg) return; // guard against double-init on retry
  // Load the UMD as a classic script so Emscripten resolves its companion
  // assets relative to /mediapipe/ (see MP_BASE note at top of file).
  if (!mpLoaded) {
    await loadScript(MP_BASE + "selfie_segmentation.js");
    mpLoaded = true;
  }
  if (typeof window.SelfieSegmentation !== "function") {
    throw new Error("Segmentation library failed to load.");
  }
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

  // Freeze on pause: return before the fade so the last frame stays on screen
  // (running the fade while not redrawing would dissolve everything to black).
  if (state.paused) return;

  const fps = 1000 / Math.max(1, now - (prevFrameT || now));
  prevFrameT = now;
  fpsSmooth = fpsSmooth ? fpsSmooth * 0.9 + fps * 0.1 : fps;
  fpsEl.textContent = state.running ? Math.round(fpsSmooth) + " fps" : "";

  // Trail fade — gives particles a soft motion glow.
  ctx.fillStyle = "rgba(5, 6, 10, 0.28)";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  if (!maskReady) return;

  const palette = PALETTES[state.paletteIdx];
  const px = state.pointer;
  const pr = CFG.pointerRadius * (canvas.width / window.innerWidth);
  const cell = CFG.step * scale; // on-screen spacing between grid cells
  const t = now / 1000; // seconds, for the organic drift

  // Draw with source-over (not additive): the trail-fade above already gives
  // motion glow, while opaque dots keep their true palette colour instead of
  // accumulating to white where they sit still.
  for (let i = 0; i < state.particles.length; i++) {
    const p = state.particles[i];
    const inside = maskValueAt(p.mx, p.my) > CFG.maskThreshold;

    // "formed-ness" eases in/out so the body gathers and disperses smoothly.
    p.life += ((inside ? 1 : 0) - p.life) * 0.1 * dt;

    // Target: the crisp grid home when inside the silhouette, otherwise an
    // organic resting spot (scattered anchor + slow layered-sine wander).
    let tx, ty, seek;
    if (inside) {
      tx = p.mx;
      ty = p.my;
      seek = CFG.ease;
    } else {
      const a = CFG.ambientAmp;
      tx = p.mx + p.ox + Math.cos(t * 0.6 + p.phase) * a + Math.sin(t * 0.23 + p.phase * 1.7) * a * 0.5;
      ty = p.my + p.oy + Math.sin(t * 0.5 + p.phase) * a + Math.cos(t * 0.19 + p.phase * 1.3) * a * 0.5;
      seek = CFG.ambientEase;
    }
    p.vx += (tx - p.x) * seek * dt;
    p.vy += (ty - p.y) * seek * dt;

    // Pointer repulsion (computed in canvas space, then fed back in mask space).
    const cx = p.x * scale + offX,
      cy = p.y * scale + offY;
    if (px.active) {
      const dx = cx - px.x,
        dy = cy - px.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < pr * pr) {
        const d = Math.sqrt(d2) || 1;
        const f = (1 - d / pr) * CFG.pointerForce;
        p.vx += ((dx / d) * f) / scale * dt;
        p.vy += ((dy / d) * f) / scale * dt;
      }
    }

    p.vx *= CFG.friction;
    p.vy *= CFG.friction;
    p.x += p.vx * dt;
    p.y += p.vy * dt;

    const drawX = p.x * scale + offX;
    const drawY = p.y * scale + offY;
    const color = palette[i % palette.length];
    // Always visible: a soft ambient dot that grows and brightens as it forms
    // the silhouette. Radius kept below half a cell so dots stay distinct.
    const r = cell * (0.1 + p.life * 0.28);

    ctx.globalAlpha = 0.28 + p.life * 0.67;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(drawX, drawY, r, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.globalAlpha = 1;
}

// ---------- Boot ----------
async function start() {
  // The camera API is only exposed in a secure context (https:// or localhost).
  // Catch this up front so phones on plain http get a clear message instead of
  // a cryptic "Cannot read properties of undefined" from mediaDevices.
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    statusEl.style.color = "#ff9a9a";
    statusEl.textContent =
      location.protocol === "file:"
        ? "Run via `npm run dev` — file:// blocks the camera."
        : "Camera needs a secure context — open this over https:// or localhost.";
    return;
  }

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
    statusEl.textContent = "";
    overlay.classList.add("hidden");
    pumpCamera();
  } catch (err) {
    startBtn.disabled = false;
    statusEl.style.color = "#ff9a9a";
    const name = err && err.name;
    if (name === "NotAllowedError" || name === "SecurityError")
      statusEl.textContent = "Camera permission denied. Allow access and try again.";
    else if (name === "NotFoundError" || name === "DevicesNotFoundError")
      statusEl.textContent = "No camera found on this device.";
    else if (name === "NotReadableError")
      statusEl.textContent = "Camera is in use by another app. Close it and retry.";
    else statusEl.textContent = "Could not start camera: " + ((err && err.message) || err);
  }
}

startBtn.addEventListener("click", start);
resize();

// The render loop runs continuously and independently of the camera — it guards
// on `maskReady`, so it simply fades an empty scene until masks start arriving.
// Decoupling it keeps the UI responsive and makes the pipeline testable.
requestAnimationFrame(render);

// Debug seam (dev builds or `?debug`): lets tooling inspect and drive the sim
// without a real person in frame. Stripped from normal production loads.
if (import.meta.env.DEV || new URLSearchParams(location.search).has("debug")) {
  window.__silhouette = {
    state,
    CFG,
    // Inject a filled rectangular "person" so the particle pipeline can be
    // exercised deterministically (used by the headless E2E check).
    fillMask(frac = 0.6) {
      if (!sized) sizeMaskTo(0.75);
      const d = new Uint8ClampedArray(mask.width * mask.height * 4);
      const x0 = mask.width * (0.5 - frac / 2),
        x1 = mask.width * (0.5 + frac / 2);
      const y0 = mask.height * (0.5 - frac / 2),
        y1 = mask.height * (0.5 + frac / 2);
      for (let y = 0; y < mask.height; y++) {
        for (let x = 0; x < mask.width; x++) {
          const inside = x >= x0 && x <= x1 && y >= y0 && y <= y1;
          const idx = (y * mask.width + x) * 4;
          d[idx] = d[idx + 1] = d[idx + 2] = inside ? 255 : 0;
          d[idx + 3] = 255;
        }
      }
      latestMaskData = d;
      maskReady = true;
      state.running = true;
    },
    // Empty mask → nobody in frame → the ambient drifting field.
    emptyMask() {
      if (!sized) sizeMaskTo(0.75);
      latestMaskData = new Uint8ClampedArray(mask.width * mask.height * 4);
      maskReady = true;
      state.running = true;
    },
  };
}
