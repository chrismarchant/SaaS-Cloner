import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/**
 * Production pages carry a strict Content-Security-Policy: scripts and styles
 * come only from this origin, so there are no inline scripts. The development
 * server needs inline preambles and is left alone.
 */
const contentSecurityPolicy = (): Plugin => ({
  name: "rea-web-csp",
  apply: "build",
  transformIndexHtml: {
    order: "post",
    handler: (html) =>
      html.replace(
        '<meta charset="utf-8" />',
        `<meta charset="utf-8" />\n    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'" />`,
      ),
  },
});

export default defineConfig({
  plugins: [react(), contentSecurityPolicy()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 800,
  },
  server: {
    proxy: {
      "/api": { target: "http://127.0.0.1:8080", changeOrigin: false },
    },
  },
});
