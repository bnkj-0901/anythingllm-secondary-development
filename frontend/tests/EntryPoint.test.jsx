import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { createBrowserRouter, matchRoutes } from "react-router-dom";

const rootRender = vi.hoisted(() => vi.fn());

vi.mock("react-dom/client", () => ({
  default: { createRoot: () => ({ render: rootRender }) },
}));
vi.mock("react-router-dom", async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    createBrowserRouter: vi.fn(original.createBrowserRouter),
  };
});
vi.mock("../src/App.jsx", () => ({
  default: () => <div>当前租户身份入口</div>,
}));
vi.mock("../src/ThemeContext", () => ({
  ThemeProvider: ({ children }) => children,
}));
vi.mock("../src/pages/Login/SSO/simple", () => ({
  default: () => <div>企业单次登录入口</div>,
}));
vi.mock("../src/pages/OnboardingFlow", () => {
  throw new Error("Inactive upstream onboarding was loaded");
});

it("restores original settings under the tenant application without global identity or Workspace routes", async () => {
  await import("../src/main");
  expect(createBrowserRouter).toHaveBeenCalledTimes(1);
  const [activeRoutes] = createBrowserRouter.mock.calls[0];
  expect(activeRoutes).toHaveLength(1);
  expect(activeRoutes[0].path).toBe("/");
  const routes = activeRoutes[0].children;
  for (const path of [
    "/settings/llm-preference",
    "/settings/transcription-preference",
    "/settings/audio-preference",
    "/settings/embedding-preference",
    "/settings/image-generation-preference",
    "/settings/text-splitter-preference",
    "/settings/vector-database",
    "/settings/event-logs",
    "/settings/privacy",
    "/settings/interface",
    "/settings/branding",
    "/settings/default-system-prompt",
    "/settings/chat",
    "/settings/system-prompt-variables",
    "/settings/retrieval-preference",
    "/sso/simple",
    "/settings/agents",
    "/settings/model-routers",
    "/settings/api-keys",
    "/settings/browser-extension",
    "/settings/mobile-connections",
    "/settings/embed-chat-widgets",
    "/settings/external-connections/telegram",
    "/settings/scheduled-jobs",
    "/settings/beta-features/live-document-sync/manage",
    "/settings/community-hub/trending",
    "/settings/community-hub/authentication",
    "/settings/community-hub/import-item",
  ]) {
    const matched = matchRoutes(activeRoutes, path);
    expect(matched.at(-1).route.path).toBe(path);
    expect(matched.at(-1).route.lazy).toBeTypeOf("function");
  }
  for (const path of [
    "/",
    "/workspace/old",
    "/onboarding",
    "/settings/users",
    "/settings/invites",
    "/settings/workspaces",
    "/settings/security",
  ]) {
    const matched = matchRoutes(activeRoutes, path);
    expect(matched[0].route).toBe(activeRoutes[0]);
    if (matched.length > 1) expect(matched.at(-1).route.path).toBe("*");
  }
  expect(
    routes.find((route) => route.path === "/settings").element.props.to
  ).toBe("/settings/interface");
  render(rootRender.mock.calls[0][0]);
  expect(screen.getByText("当前租户身份入口")).toBeInTheDocument();
});
