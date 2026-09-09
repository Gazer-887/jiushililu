// config/electron.vite.config.ts
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
var r = (p) => resolve(process.cwd(), p);
var electron_vite_config_default = defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { "@shared": r("src/shared"), "@main": r("src/main") }
    },
    build: {
      outDir: r("out/main"),
      rollupOptions: { input: { index: r("src/main/index.ts") } }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { "@shared": r("src/shared") }
    },
    build: {
      outDir: r("out/preload"),
      rollupOptions: { input: { index: r("src/preload/index.ts") } }
    }
  },
  renderer: {
    root: r("src/renderer"),
    plugins: [react()],
    resolve: {
      alias: { "@shared": r("src/shared"), "@": r("src/renderer/src") }
    },
    build: {
      outDir: r("out/renderer"),
      rollupOptions: { input: { index: r("src/renderer/index.html") } }
    }
  }
});
export {
  electron_vite_config_default as default
};
