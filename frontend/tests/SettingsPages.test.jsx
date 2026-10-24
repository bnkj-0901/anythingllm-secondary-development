import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { AuthContext } from "../src/AuthContext";
import { LogoContext } from "../src/LogoContext";
import { ThemeProvider } from "../src/ThemeContext";
import SettingsSidebar from "../src/components/SettingsSidebar";
import InterfaceSettings from "../src/pages/GeneralSettings/Settings/Interface";
import ChatSettings from "../src/pages/GeneralSettings/Settings/Chat";
import SpeechToTextProvider from "../src/pages/GeneralSettings/AudioPreference/stt";
import GeneralLLMPreference from "../src/pages/GeneralSettings/LLMPreference";
import TranscriptionModelPreference from "../src/pages/GeneralSettings/TranscriptionPreference";
import System from "../src/models/system";
import Appearance from "../src/models/appearance";
import i18n from "../src/i18n";

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(System, "fetchSupportEmail").mockResolvedValue({ email: "" });
  vi.spyOn(System, "fetchAppVersion").mockResolvedValue("1.0.0");
  vi.spyOn(System, "fetchCustomFooterIcons").mockResolvedValue({
    footerData: [],
  });
});

function settings(
  element,
  identity = "tenant",
  role = "user",
  pathname = "/settings/interface"
) {
  return render(
    <MemoryRouter initialEntries={[pathname]}>
      <ThemeProvider>
        <AuthContext.Provider
          value={{ store: { user: { identity, role, username: "alice" } } }}
        >
          <LogoContext.Provider value={{ logo: "logo.png" }}>
            {element}
          </LogoContext.Provider>
        </AuthContext.Provider>
      </ThemeProvider>
    </MemoryRouter>
  );
}

async function expandedLinks() {
  for (const name of [
    "settings.ai-providers",
    "settings.admin",
    "settings.community-hub.title",
    "settings.channels",
    "settings.customization",
    "settings.tools",
  ]) {
    const group = screen.queryByRole("link", {
      name: i18n.t(name),
      exact: true,
    });
    if (group) fireEvent.click(group);
  }
  await screen.findByText("v1.0.0");
  return [...document.querySelectorAll('a[href^="/settings/"]')]
    .filter(
      (node) => !node.hidden && node.getAttribute("href") !== "/settings/test"
    )
    .map((node) => node.getAttribute("href"));
}

describe("original settings layouts and controls remain functional with SaaS scopes", () => {
  it.each([
    [
      "platform",
      "platform_admin",
      [
        "llm-preference",
        "embedding-preference",
        "vector-database",
        "text-splitter-preference",
        "image-generation-preference",
        "audio-preference",
        "transcription-preference",
        "branding",
        "default-system-prompt",
        "retrieval-preference",
        "agents",
        "model-routers",
        "api-keys",
        "embed-chat-widgets",
        "external-connections/telegram",
        "scheduled-jobs",
        "event-logs",
        "system-prompt-variables",
        "privacy",
      ],
    ],
    [
      "tenant",
      "admin",
      [
        "api-keys",
        "embed-chat-widgets",
        "browser-extension",
        "mobile-connections",
        "external-connections/telegram",
        "scheduled-jobs",
      ],
    ],
    [
      "tenant",
      "user",
      [
        "browser-extension",
        "mobile-connections",
        "external-connections/telegram",
        "scheduled-jobs",
      ],
    ],
  ])(
    "shows supported settings for %s %s without upstream account/Workspace controls",
    async (identity, role, adminPages) => {
      settings(<SettingsSidebar />, identity, role, "/settings/test");
      const links = await expandedLinks();
      expect(links).toEqual(
        expect.arrayContaining(
          [...adminPages, "interface", "chat"].map(
            (path) => `/settings/${path}`
          )
        )
      );
      expect(links.join(" ")).not.toMatch(
        /workspaces|users|invites|security|workspace-chats/
      );
      if (identity === "tenant") {
        for (const path of [
          "llm-preference",
          "embedding-preference",
          "vector-database",
          "text-splitter-preference",
          "branding",
          "default-system-prompt",
          "retrieval-preference",
          "agents",
          "model-routers",
        ]) {
          expect(links).not.toContain(`/settings/${path}`);
        }
        if (role === "user") {
          expect(links).not.toContain("/settings/api-keys");
          expect(links).not.toContain("/settings/embed-chat-widgets");
        }
      }
    }
  );

  it("changes language and theme through the original interface page", async () => {
    settings(<InterfaceSettings />);
    const origin = window.location.origin;
    const language = screen
      .getAllByRole("combobox")
      .find((node) => node.name === "userLang");
    expect(language.options).toHaveLength(31);
    fireEvent.change(language, { target: { value: "en" } });
    await waitFor(() => expect(i18n.language).toBe("en"));
    const theme = screen
      .getAllByRole("combobox")
      .find((node) => node.name !== "userLang");
    fireEvent.change(theme, { target: { value: "light" } });
    expect(localStorage.getItem("theme")).toBe("light");
    expect(window.location.origin).toBe(origin);
  });

  it("restores every original chat preference including speech auto-submit and auto-play", () => {
    settings(<ChatSettings />, "tenant", "user", "/settings/chat");
    const toggles = screen.getAllByRole("checkbox");
    expect(toggles).toHaveLength(6);
    const autoSubmit = screen.getByRole("checkbox", {
      name: new RegExp(i18n.t("customization.chat.auto_submit.title")),
    });
    const autoSpeak = screen.getByRole("checkbox", {
      name: new RegExp(i18n.t("customization.chat.auto_speak.title")),
    });
    fireEvent.click(autoSubmit);
    fireEvent.click(autoSpeak);
    expect(Appearance.get("autoSubmitSttInput")).toBe(false);
    expect(Appearance.get("autoPlayAssistantTtsResponse")).toBe(true);
  });

  it("saves speech provider preferences through the original form contract", async () => {
    vi.spyOn(System, "customModels").mockResolvedValue({
      models: [{ id: "whisper-1", name: "Whisper" }],
    });
    let finishSave;
    const update = vi.spyOn(System, "updateSystem").mockImplementation(
      () =>
        new Promise((resolve) => {
          finishSave = resolve;
        })
    );
    render(
      <SpeechToTextProvider
        settings={{ SpeechToTextProvider: "native", OpenAiKey: true }}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /System native/ }));
    expect(
      screen.getByPlaceholderText("Search speech to text providers")
    ).toBeInTheDocument();
    fireEvent.click(screen.getByText("OpenAI", { exact: true }));
    await screen.findByRole("option", { name: "Whisper" });
    fireEvent.submit(
      screen.getByRole("button", { name: "Save changes" }).closest("form")
    );
    expect(update).toHaveBeenCalledOnce();
    expect(update).toHaveBeenCalledWith({
      SpeechToTextProvider: "openai",
      OpenAiKey: "*".repeat(20),
      STTOpenAIModel: "whisper-1",
    });
    expect(
      screen.getByRole("button", { name: "Save changes" })
    ).toBeInTheDocument();
    await act(async () => finishSave({ error: null }));
    expect(
      screen.queryByRole("button", { name: "Save changes" })
    ).not.toBeInTheDocument();
  });

  it("loads the original LLM provider list and saves its selected model through the form", async () => {
    vi.spyOn(System, "keys").mockResolvedValue({
      LLMProvider: "deepseek",
      DeepSeekApiKey: true,
      DeepSeekModelPref: "deepseek-chat",
    });
    vi.spyOn(System, "customModels").mockResolvedValue({
      models: [{ id: "deepseek-chat", name: "DeepSeek Chat" }],
    });
    const update = vi
      .spyOn(System, "updateSystem")
      .mockResolvedValue({ error: null });
    settings(
      <GeneralLLMPreference />,
      "platform",
      "platform_admin",
      "/settings/llm-preference"
    );
    await screen.findByRole("option", { name: "DeepSeek Chat" });
    fireEvent.change(screen.getByPlaceholderText("DeepSeek API Key"), {
      target: { value: "replacement-test-key" },
    });
    fireEvent.submit(
      screen.getByRole("button", { name: "Save changes" }).closest("form")
    );
    await waitFor(() => expect(update).toHaveBeenCalledOnce());
    expect(update).toHaveBeenCalledWith({
      LLMProvider: "deepseek",
      DeepSeekApiKey: "replacement-test-key",
      DeepSeekModelPref: "deepseek-chat",
    });
    fireEvent.click(screen.getByRole("button", { name: /DeepSeek/ }));
    expect(
      screen.getByPlaceholderText("Search all LLM providers")
    ).toBeInTheDocument();
    expect(screen.getByText("OpenAI", { exact: true })).toBeInTheDocument();
    expect(screen.getByText("Ollama", { exact: true })).toBeInTheDocument();
  });

  it("saves the original transcription form through its submit event", async () => {
    vi.spyOn(System, "keys").mockResolvedValue({
      WhisperProvider: "local",
      WhisperModelPref: "Xenova/whisper-small",
    });
    const update = vi
      .spyOn(System, "updateSystem")
      .mockResolvedValue({ error: null });
    settings(
      <TranscriptionModelPreference />,
      "platform",
      "platform_admin",
      "/settings/transcription-preference"
    );
    const model = await screen.findByRole("combobox");
    fireEvent.change(model, { target: { value: "Xenova/whisper-tiny" } });
    fireEvent.submit(
      screen.getByRole("button", { name: "Save changes" }).closest("form")
    );
    await waitFor(() => expect(update).toHaveBeenCalledOnce());
    expect(update.mock.calls[0][0].WhisperProvider).toBe("local");
  });
});
