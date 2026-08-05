import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: new URL(".", import.meta.url).pathname,
  base: "/admin/",
  plugins: [react()],
  build: {
    outDir: "../public/admin",
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      input: new URL("app.html", import.meta.url).pathname,
      output: {
        entryFileNames: "assets/admin.js",
        assetFileNames: (assetInfo) => assetInfo.names.some((name) => name.endsWith(".css"))
          ? "assets/admin.css"
          : "assets/[name]-[hash][extname]",
      },
    },
  },
});
