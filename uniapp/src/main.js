import { createSSRApp } from "vue";
import App from "./App.vue";
import { createEnterpriseClient } from "./services/enterprise.mjs";
export function createApp() {
  const app = createSSRApp(App);
  app.provide(
    "enterprise-api",
    createEnterpriseClient({
      runtime: uni,
      onUnauthorized() {
        uni.$emit("enterprise-unauthorized");
      },
    })
  );
  return { app };
}
