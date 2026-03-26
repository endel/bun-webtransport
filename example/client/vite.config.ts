import { defineConfig } from "vite";

export default defineConfig({
  base: process.env.VITE_BASE_PATH || "/",
  server: {
    host: true,
    proxy: {
      "/cert-hash": "http://localhost:3000",
    },
  },
});
