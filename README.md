# Particle Silhouette

An interactive web page that captures your silhouette from the camera and renders
it as a field of living particles. Everything runs **in the browser** — the video
never leaves your device.

![demo](https://img.shields.io/badge/runs-100%25%20in%20browser-58e6c9)

## How it works

1. **Camera** — `getUserMedia` grabs the webcam (laptop or mobile front camera).
2. **Silhouette** — [MediaPipe Selfie Segmentation](https://developers.google.com/mediapipe)
   produces a per-pixel "is this a person?" mask, fully on-device.
3. **Particles** — a grid of particles samples the mask. Particles whose cell falls
   inside your body light up and snap to their home position, forming your outline;
   particles outside drift and fade.
4. **Interaction** — move the mouse or drag a finger to push particles around.

### Why MediaPipe?

For a *filled* silhouette you need a segmentation mask, not just skeleton joints.
Selfie Segmentation is real-time (~30 fps) on phones, ships as one CDN script, and
keeps video on-device. Pose-landmark models only give ~33 points (a skeleton);
TensorFlow.js BodyPix is heavier and slower. Segmentation is the right tool here.

## Running it

The camera API **only works over HTTPS or `localhost`** — opening `index.html`
directly as a `file://` URL will not get camera access.

```bash
# any static server works; for example:
python3 -m http.server 8000
# then open http://localhost:8000
```

On mobile, serve it over HTTPS (e.g. a tunneling tool or any static host) and
open it in the phone's browser, then allow camera access.

## Controls

| Control     | What it does                              |
| ----------- | ----------------------------------------- |
| 🎨 Palette  | Cycle through color schemes               |
| 🪞 Mirror   | Flip the camera (mirror vs. normal)       |
| 💥 Explode  | Blast the particles apart, then re-form   |
| ⏸ Pause     | Freeze the simulation                     |
| mouse/touch | Push nearby particles away                |

## Tuning

Open `index.html` and edit the `CFG` object near the top of the script:

| Key             | Effect                                            |
| --------------- | ------------------------------------------------- |
| `step`          | Particle density (smaller = more particles)       |
| `sampleW`       | Mask resolution (higher = sharper edge, slower)   |
| `ease`          | How fast particles snap into the silhouette       |
| `pointerRadius` | Reach of the mouse/touch repulsion                |
| `maskThreshold` | How confident a pixel must be to count as "person"|

If it feels slow on a phone, raise `step` (e.g. `7`) and/or lower `sampleW`.
