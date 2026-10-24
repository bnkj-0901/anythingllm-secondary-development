import { defineConfig } from "vitest/config"
import { fileURLToPath, URL } from "node:url"
import react from "@vitejs/plugin-react"

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    environment: "jsdom",
    setupFiles: ["./tests/setup.js"],
    include: ["tests/**/*.test.{js,jsx}"],
    poolOptions: { threads: { singleThread: true } },
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "html"],
      // Coverage tracks product controllers and boundary adapters. Untouched
      // upstream providers, renderers, and utility libraries are outside this metric.
      include: [
        "src/pages/GeneralSettings/RetrievalPreference/**/*.{js,jsx}",
        "src/components/PrivateRoute/index.jsx",
        "src/components/SettingsSidebar/index.jsx",
        "src/utils/request.js",
        "src/pages/Login.jsx",
        "src/pages/Management.jsx",
        "src/pages/Knowledge.jsx",
        "src/pages/Chat.jsx",
        "src/models/platform.js",
        "src/models/media.js",
        "src/App.jsx",
        "src/components/Sidebar/TenantNavigation.jsx"
      ],
      reportsDirectory: "./coverage",
      thresholds: { lines: 85, statements: 85, functions: 85, branches: 75 }
    }
  }
})
