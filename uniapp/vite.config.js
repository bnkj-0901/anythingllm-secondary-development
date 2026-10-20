import { defineConfig, loadEnv } from "vite"
import uni from "@dcloudio/vite-plugin-uni"

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "")
  return {
    plugins: [uni()],
    server: {
      host: "0.0.0.0",
      port: 5173,
      proxy: {
        "/api": {
          target: env.VITE_API_PROXY_TARGET || "http://127.0.0.1:3001",
          changeOrigin: true
        }
      }
    }
  }
})
