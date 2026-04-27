import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 4001,
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
      "/api/bot/1": {
        target: "http://localhost:3003",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/bot\/1/, ""),
      },
      "/api/bot/3": {
        target: "http://localhost:3004",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/bot\/3/, ""),
      },
      "/api/bot/4": {
        target: "http://localhost:3005",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/bot\/4/, ""),
      },
      "/api/bot/5": {
        target: "http://localhost:3006",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/bot\/5/, ""),
      },
      "/api/bot/6": {
        target: "http://localhost:3007",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/bot\/6/, ""),
      },
      "/api/bot/7": {
        target: "http://localhost:3008",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/bot\/7/, ""),
      },
    },
  },
});
