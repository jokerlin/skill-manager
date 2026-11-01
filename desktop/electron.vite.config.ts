import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

export default defineConfig({
  main: {
    build: { rollupOptions: { input: resolve(__dirname, "src/main/index.ts"), external: ["original-fs"] } },
  },
  preload: {
    build: { rollupOptions: { input: resolve(__dirname, "src/preload/index.ts"), output: { format: "cjs", entryFileNames: "[name].cjs" } } },
  },
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    resolve: { alias: { "@": resolve(__dirname, "src/renderer/src"), "@shared": resolve(__dirname, "src/shared") } },
    plugins: [react(), tailwindcss()],
    build: { rollupOptions: { input: resolve(__dirname, "src/renderer/index.html") } },
  },
});
