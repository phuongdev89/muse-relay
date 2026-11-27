import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Pure client SPA: the dashboard talks to Supabase directly (auth + REST +
// Edge Functions), so the build is plain static files — serve dist/ anywhere.
export default defineConfig({
  plugins: [react()],
});
