import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "/participant": fileURLToPath(new URL("../src/participant", import.meta.url)) },
  },
  server: {
    port: 5173,
    proxy: {
      "/ws": {
        target: "ws://localhost:3000",
        ws: true,
      },
      "/analytics": {
        target: "http://localhost:3000",
      },
    },
  },
});
