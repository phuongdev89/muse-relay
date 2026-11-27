import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Frontend SPA proxied to the Express backend (`/api/*`) in dev; in production
// `server/` serves both `/api/*` and the built `dashboard/dist` static bundle.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": {
        target: process.env.VITE_API_ORIGIN || "http://127.0.0.1:3000",
        changeOrigin: true,
      },
    },
  },
});
