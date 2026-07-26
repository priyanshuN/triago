import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/** The frontend ships prebuilt inside dist/web — users never run a build. */
export default defineConfig({
  root: "web",
  plugins: [react()],
  build: {
    outDir: "../dist/web",
    emptyOutDir: true,
    target: "es2022",
  },
  server: {
    port: 5600,
    proxy: {
      "/api": "http://127.0.0.1:5599",
      "/healthz": "http://127.0.0.1:5599",
    },
  },
});
