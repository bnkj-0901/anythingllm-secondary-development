import React, { Suspense } from "react";
import ReactDOM from "react-dom/client";
import {
  createBrowserRouter,
  Navigate,
  RouterProvider,
} from "react-router-dom";
import App from "@/App.jsx";
import NotFound from "@/pages/404";
import PrivateRoute, {
  AdminRoute,
  PlatformRoute,
} from "@/components/PrivateRoute";
import "@/index.css";
import { ThemeProvider } from "@/ThemeContext";
import { I18nextProvider } from "react-i18next";
import i18n from "@/i18n";
import { FullScreenLoader } from "@/components/Preloader";

const isDev = import.meta.env.DEV;
const REACTWRAP = isDev ? React.Fragment : React.StrictMode;

const router = createBrowserRouter([
  {
    path: "/",
    element: (
      <I18nextProvider i18n={i18n}>
        <ThemeProvider>
          <Suspense fallback={<FullScreenLoader />}>
            <App />
          </Suspense>
        </ThemeProvider>
      </I18nextProvider>
    ),
    children: [
      ...[
        "/chat",
        "/knowledge",
        "/users",
        "/tenants",
        "/connections",
        "/login",
      ].map((path) => ({ path, element: null })),
      {
        path: "/sso/simple",
        lazy: async () => {
          const { default: Page } = await import("@/pages/Login/SSO/simple");
          return { element: <Page /> };
        },
      },
      {
        path: "/settings",
        element: <Navigate to="/settings/interface" replace />,
      },
      {
        path: "/settings/llm-preference",
        lazy: async () => {
          const { default: GeneralLLMPreference } = await import(
            "@/pages/GeneralSettings/LLMPreference"
          );
          return {
            element: <PlatformRoute Component={GeneralLLMPreference} />,
          };
        },
      },
      {
        path: "/settings/transcription-preference",
        lazy: async () => {
          const { default: GeneralTranscriptionPreference } = await import(
            "@/pages/GeneralSettings/TranscriptionPreference"
          );
          return {
            element: (
              <PlatformRoute Component={GeneralTranscriptionPreference} />
            ),
          };
        },
      },
      {
        path: "/settings/audio-preference",
        lazy: async () => {
          const { default: GeneralAudioPreference } = await import(
            "@/pages/GeneralSettings/AudioPreference"
          );
          return {
            element: <PlatformRoute Component={GeneralAudioPreference} />,
          };
        },
      },
      {
        path: "/settings/embedding-preference",
        lazy: async () => {
          const { default: GeneralEmbeddingPreference } = await import(
            "@/pages/GeneralSettings/EmbeddingPreference"
          );
          return {
            element: <PlatformRoute Component={GeneralEmbeddingPreference} />,
          };
        },
      },
      {
        path: "/settings/image-generation-preference",
        lazy: async () => {
          const { default: ImageGenerationPreference } = await import(
            "@/pages/GeneralSettings/ImageGenerationPreference"
          );
          return {
            element: <PlatformRoute Component={ImageGenerationPreference} />,
          };
        },
      },
      {
        path: "/settings/text-splitter-preference",
        lazy: async () => {
          const { default: EmbeddingTextSplitterPreference } = await import(
            "@/pages/GeneralSettings/EmbeddingTextSplitterPreference"
          );
          return {
            element: (
              <PlatformRoute Component={EmbeddingTextSplitterPreference} />
            ),
          };
        },
      },
      {
        path: "/settings/vector-database",
        lazy: async () => {
          const { default: GeneralVectorDatabase } = await import(
            "@/pages/GeneralSettings/VectorDatabase"
          );
          return {
            element: <PlatformRoute Component={GeneralVectorDatabase} />,
          };
        },
      },
      {
        path: "/settings/event-logs",
        lazy: async () => {
          const { default: AdminLogs } = await import("@/pages/Admin/Logging");
          return { element: <PlatformRoute Component={AdminLogs} /> };
        },
      },
      {
        path: "/settings/privacy",
        lazy: async () => {
          const { default: PrivacyAndData } = await import(
            "@/pages/GeneralSettings/PrivacyAndData"
          );
          return { element: <PlatformRoute Component={PrivacyAndData} /> };
        },
      },
      {
        path: "/settings/interface",
        lazy: async () => {
          const { default: InterfaceSettings } = await import(
            "@/pages/GeneralSettings/Settings/Interface"
          );
          return { element: <PrivateRoute Component={InterfaceSettings} /> };
        },
      },
      {
        path: "/settings/branding",
        lazy: async () => {
          const { default: BrandingSettings } = await import(
            "@/pages/GeneralSettings/Settings/Branding"
          );
          return { element: <PlatformRoute Component={BrandingSettings} /> };
        },
      },
      {
        path: "/settings/default-system-prompt",
        lazy: async () => {
          const { default: DefaultSystemPrompt } = await import(
            "@/pages/Admin/DefaultSystemPrompt"
          );
          return { element: <PlatformRoute Component={DefaultSystemPrompt} /> };
        },
      },
      {
        path: "/settings/chat",
        lazy: async () => {
          const { default: ChatSettings } = await import(
            "@/pages/GeneralSettings/Settings/Chat"
          );
          return { element: <PrivateRoute Component={ChatSettings} /> };
        },
      },
      {
        path: "/settings/system-prompt-variables",
        lazy: async () => {
          const { default: SystemPromptVariables } = await import(
            "@/pages/Admin/SystemPromptVariables"
          );
          return {
            element: <PlatformRoute Component={SystemPromptVariables} />,
          };
        },
      },
      {
        path: "/settings/retrieval-preference",
        lazy: async () => {
          const { default: RetrievalPreference } = await import(
            "@/pages/GeneralSettings/RetrievalPreference"
          );
          return {
            element: <PlatformRoute Component={RetrievalPreference} />,
          };
        },
      },
      {
        path: "/settings/agents",
        lazy: async () => {
          const { default: Page } = await import("@/pages/Admin/Agents");
          return { element: <PlatformRoute Component={Page} /> };
        },
      },
      {
        path: "/settings/agents/builder/:flowId?",
        lazy: async () => {
          const { default: Page } = await import("@/pages/Admin/AgentBuilder");
          return { element: <PlatformRoute Component={Page} /> };
        },
      },
      {
        path: "/settings/model-routers",
        lazy: async () => {
          const { default: Page } = await import(
            "@/pages/GeneralSettings/ModelRouters"
          );
          return { element: <PlatformRoute Component={Page} /> };
        },
      },
      {
        path: "/settings/model-routers/:id",
        lazy: async () => {
          const { default: Page } = await import(
            "@/pages/GeneralSettings/ModelRouters/RouterRulesPage"
          );
          return { element: <PlatformRoute Component={Page} /> };
        },
      },
      {
        path: "/settings/api-keys",
        lazy: async () => {
          const { default: Page } = await import(
            "@/pages/GeneralSettings/ApiKeys"
          );
          return { element: <AdminRoute Component={Page} /> };
        },
      },
      {
        path: "/settings/browser-extension",
        lazy: async () => {
          const { default: Page } = await import(
            "@/pages/GeneralSettings/BrowserExtensionApiKey"
          );
          return { element: <PrivateRoute Component={Page} /> };
        },
      },
      {
        path: "/settings/mobile-connections",
        lazy: async () => {
          const { default: Page } = await import(
            "@/pages/GeneralSettings/MobileConnections"
          );
          return { element: <PrivateRoute Component={Page} /> };
        },
      },
      {
        path: "/settings/embed-chat-widgets",
        lazy: async () => {
          const { default: Page } = await import(
            "@/pages/GeneralSettings/ChatEmbedWidgets"
          );
          return { element: <AdminRoute Component={Page} /> };
        },
      },
      {
        path: "/settings/external-connections/telegram",
        lazy: async () => {
          const { default: Page } = await import(
            "@/pages/GeneralSettings/Connections/TelegramBot"
          );
          return { element: <PrivateRoute Component={Page} /> };
        },
      },
      {
        path: "/settings/scheduled-jobs",
        lazy: async () => {
          const { default: Page } = await import(
            "@/pages/GeneralSettings/ScheduledJobs"
          );
          return { element: <PrivateRoute Component={Page} /> };
        },
      },
      {
        path: "/settings/beta-features/live-document-sync/manage",
        lazy: async () => {
          const { default: Page } = await import(
            "@/pages/Admin/ExperimentalFeatures/Features/LiveSync/manage"
          );
          return { element: <PrivateRoute Component={Page} /> };
        },
      },
      {
        path: "/settings/beta-features",
        lazy: async () => {
          const { default: Page } = await import(
            "@/pages/Admin/ExperimentalFeatures"
          );
          return { element: <PlatformRoute Component={Page} /> };
        },
      },
      {
        path: "/settings/scheduled-jobs/:id/runs",
        lazy: async () => {
          const { default: Page } = await import(
            "@/pages/GeneralSettings/ScheduledJobs/RunHistoryPage"
          );
          return { element: <PrivateRoute Component={Page} /> };
        },
      },
      {
        path: "/settings/scheduled-jobs/:id/runs/:runId",
        lazy: async () => {
          const { default: Page } = await import(
            "@/pages/GeneralSettings/ScheduledJobs/RunDetailPage"
          );
          return { element: <PrivateRoute Component={Page} /> };
        },
      },
      {
        path: "/settings/community-hub/trending",
        lazy: async () => {
          const { default: Page } = await import(
            "@/pages/GeneralSettings/CommunityHub/Trending"
          );
          return { element: <PlatformRoute Component={Page} /> };
        },
      },
      {
        path: "/settings/community-hub/authentication",
        lazy: async () => {
          const { default: Page } = await import(
            "@/pages/GeneralSettings/CommunityHub/Authentication"
          );
          return { element: <PlatformRoute Component={Page} /> };
        },
      },
      {
        path: "/settings/community-hub/import-item",
        lazy: async () => {
          const { default: Page } = await import(
            "@/pages/GeneralSettings/CommunityHub/ImportItem"
          );
          return { element: <PlatformRoute Component={Page} /> };
        },
      },
      { path: "*", element: <NotFound /> },
    ],
  },
]);

ReactDOM.createRoot(document.getElementById("root")).render(
  <REACTWRAP>
    <RouterProvider router={router} />
  </REACTWRAP>
);
