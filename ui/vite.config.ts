import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// in development the API runs separately: python -m papertrader serve
const api = "http://127.0.0.1:8000";
const routes = ["/accounts", "/portfolio", "/orders", "/market", "/watchlist", "/models", "/settings", "/status", "/health"];

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // served from this computer, so one bundle is fine
  build: { outDir: "../papertrader/static", emptyOutDir: true, chunkSizeWarningLimit: 900 },
  server: {
    proxy: { ...Object.fromEntries(routes.map((route) => [route, api])), "/ws": { target: api, ws: true } },
  },
});
