import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  optimizeDeps: {
    // Le pré-bundling Vite casse le worker de MapLibre (maplibre-gl-worker.mjs introuvable en dev :
    // ni tuiles ni GeoJSON ne sont décodés). Sans effet sur le build de production.
    exclude: ["maplibre-gl"],
  },
});
