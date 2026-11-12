import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  // GitHub Pages 项目站点（https://<user>.github.io/<repo>/）下资源必须是相对路径
  base: "./",
  plugins: [react()],
});
