# Particle Silhouette

An interactive web page that captures your silhouette from the camera and renders
it as a field of living particles. Everything runs **in the browser** — the video
never leaves your device.

![demo](https://img.shields.io/badge/runs-100%25%20in%20browser-58e6c9)

## How it works

1. **Camera** — `getUserMedia` grabs the webcam (laptop or mobile front camera).
2. **Silhouette** — [MediaPipe Selfie Segmentation](https://developers.google.com/mediapipe)
   produces a per-pixel "is this a person?" mask, live, fully on-device.
3. **Particles** — a grid of particles samples the mask every frame. Particles whose
   cell falls inside your body light up and snap to their home position, forming your
   outline; particles outside drift and fade. It's continuous real-time tracking, not
   a snapshot — move and the silhouette follows you.
4. **Interaction** — move the mouse or drag a finger to push particles around.

### Why MediaPipe?

For a *filled* silhouette you need a segmentation mask, not just skeleton joints.
Selfie Segmentation is real-time (~30 fps) on phones, keeps video on-device, and the
model is small. Pose-landmark models only give ~33 points (a skeleton); TensorFlow.js
BodyPix is heavier and slower. Segmentation is the right tool here.

## Getting started

This is a [Vite](https://vitejs.dev/) project.

```bash
npm install      # install dependencies
npm run dev      # start the dev server (hot reload)
```

Open the printed URL — usually **http://localhost:5173**. Click **Enable camera**
and allow access.

> The camera API only works in a **secure context** — `localhost` counts, so the dev
> server is fine. Opening the built `index.html` directly as a `file://` URL will
> **not** get camera access (browsers treat `file:` as a locked-down origin).

### Testing on your phone

`vite.config.js` sets `server.host = true`, so `npm run dev` also prints a
**Network** URL (e.g. `http://192.168.x.x:5173`). Phones require **HTTPS** for the
camera, though, so for mobile testing either:

- add [`@vitejs/plugin-basic-ssl`](https://github.com/vitejs/vite-plugin-basic-ssl)
  to the `plugins` array in `vite.config.js`, then reopen the Network URL over
  `https://`, **or**
- deploy the build (below) to any HTTPS host and open that.

## Building for production

```bash
npm run build    # outputs an optimized static site to dist/
npm run preview  # serve dist/ locally to check it
```

`dist/` is a plain static folder you can drop on GitHub Pages, Netlify, Vercel, or
any static host. The MediaPipe `.wasm`/`.tflite` assets are **self-hosted** (copied
into `dist/mediapipe/` at build time), so the app works without any CDN.

## Project layout

```
index.html        # markup + styles, loads src/main.js as a module
src/main.js        # camera, segmentation, particle system, render loop
vite.config.js     # base path + copies MediaPipe assets out of node_modules
package.json
```

## Controls

| Control     | What it does                              |
| ----------- | ----------------------------------------- |
| 🎨 Palette  | Cycle through color schemes               |
| 🪞 Mirror   | Flip the camera (mirror vs. normal)       |
| 💥 Explode  | Blast the particles apart, then re-form   |
| ⏸ Pause     | Freeze the simulation                     |
| mouse/touch | Push nearby particles away                |

## Tuning

Edit the `CFG` object near the top of `src/main.js`:

| Key             | Effect                                             |
| --------------- | -------------------------------------------------- |
| `step`          | Particle density (smaller = more particles)        |
| `sampleW`       | Mask resolution (higher = sharper edge, slower)    |
| `ease`          | How fast particles snap into the silhouette        |
| `pointerRadius` | Reach of the mouse/touch repulsion                 |
| `maskThreshold` | How confident a pixel must be to count as "person" |

If it feels slow on a phone, raise `step` (e.g. `7`) and/or lower `sampleW`.
