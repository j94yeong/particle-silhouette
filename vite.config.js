import { defineConfig } from "vite";
import { viteStaticCopy } from "vite-plugin-static-copy";

// Relative base so the built site works both at a domain root and under a
// GitHub Pages project subpath (e.g. /particle-silhouette/).
export default defineConfig({
  base: "./",
  plugins: [
    // MediaPipe loads its .wasm/.tflite/.data assets at runtime. Copy them out
    // of node_modules so we self-host them (works offline, no CDN dependency)
    // in both `vite dev` and the production build.
    viteStaticCopy({
      targets: [
        {
          src: "node_modules/@mediapipe/selfie_segmentation/*",
          dest: "mediapipe",
        },
      ],
    }),
  ],
  server: {
    host: true, // expose on the LAN so you can open it on your phone
    // To test the mobile camera over HTTPS, install `@vitejs/plugin-basic-ssl`
    // and add it to `plugins`, or run `vite --https` with your own certs.
  },
});
