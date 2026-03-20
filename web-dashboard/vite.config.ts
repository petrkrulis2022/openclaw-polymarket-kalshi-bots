import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 4000,
    host: true,
    proxy: {
      "/api/treasury": {
        target: "http://localhost:3001",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/treasury/, ""),
      },
      "/api/orchestrator": {
        target: "http://localhost:3002",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/orchestrator/, ""),
      },
    },
  },
});
