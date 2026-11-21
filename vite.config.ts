import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  base: "./",
  server: { host: "127.0.0.1", port: 5173, strictPort: true },
  // AudioWorklet must be a same-origin file under the renderer CSP.
  build: { target: "es2022", assetsInlineLimit: 0 },
});
