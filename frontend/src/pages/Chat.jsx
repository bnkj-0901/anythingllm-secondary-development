import { MessageActionsProvider } from "@/components/WorkspaceChat/ChatContainer/ChatHistory/MessageActionsContext";
import { useEffect, useMemo, useRef, useState, useContext } from "react";
import {
  api,
  streamMessage,
  exportConversation,
  TOKEN_KEY,
} from "@/models/platform";
import { ttsMessage } from "@/models/media";
import SuggestedMessages from "@/components/lib/SuggestedMessages";
import { useTranslation } from "react-i18next";
import useAutoScroll from "@/hooks/useAutoScroll";
import PromptInput, {
  PROMPT_INPUT_EVENT,
  PROMPT_INPUT_ID,
} from "@/components/WorkspaceChat/ChatContainer/PromptInput";
import { buildMessages } from "@/components/WorkspaceChat/ChatContainer/ChatHistory";
import StatusResponse from "@/components/WorkspaceChat/ChatContainer/ChatHistory/StatusResponse";
import { ThoughtExpansionProvider } from "@/components/WorkspaceChat/ChatContainer/ChatHistory/ThoughtContainer";
import DnDFileUploaderWrapper, {
  DnDFileUploaderProvider,
  DndUploaderContext,
  CLEAR_ATTACHMENTS_EVENT,
  ATTACHMENTS_PROCESSING_EVENT,
  ATTACHMENTS_PROCESSED_EVENT,
} from "@/components/WorkspaceChat/ChatContainer/DnDWrapper";
import SourcesSidebar from "@/components/WorkspaceChat/ChatContainer/SourcesSidebar";
import MemoriesSidebar from "@/components/WorkspaceChat/ChatContainer/MemoriesSidebar";
import handleSocketResponse, {
  websocketURI,
  agentEventLoadingState,
  setAgentSessionActive,
  setAgentSessionSocket,
  AGENT_SESSION_END,
  AGENT_SESSION_START,
} from "@/utils/chat/agent";
import { getSessionReasoningEffort } from "@/utils/chat/reasoningEffort";
import useGreeting from "@/hooks/useGreeting";
import { clearPromptInputDraft } from "@/hooks/usePromptInputStorage";
import { ArrowDown } from "@phosphor-icons/react";
import ChatSettingsMenu from "@/components/WorkspaceChat/ChatContainer/ChatSettingsMenu";
import useAppearance from "@/hooks/useAppearance";
import useChatContainerQuickScroll from "@/hooks/useChatContainerQuickScroll";
import { Notice, Modal } from "@/components/lib/PlatformUI";
import { ChatSidebarProvider } from "@/components/WorkspaceChat/ChatContainer/ChatSidebar";
import handleChat, { ABORT_STREAM_EVENT } from "@/utils/chat";
import { MetricsProvider } from "@/components/WorkspaceChat/ChatContainer/ChatHistory/HistoricalMessage/Actions/RenderMetrics";
import {
  TTSProvider,
  useWatchForAutoPlayAssistantTTSResponse,
} from "@/components/contexts/TTSProvider";

export default function Chat(props) {
  return (
    <ChatSidebarProvider>
      <MetricsProvider>
        <TTSProvider>
          <ChatController {...props} />
        </TTSProvider>
      </MetricsProvider>
    </ChatSidebarProvider>
  );
}

function ChatController({ session, onNavigation }) {
  useWatchForAutoPlayAssistantTTSResponse();
  const greeting = useGreeting();
  const { t } = useTranslation();
  const [conversations, setConversations] = useState([]);
  const [suggestions, setSuggestions] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const activeConversation = useRef(null);
  const conversationCreation = useRef(null);
  const [attachmentScope, setAttachmentScope] = useState(() =>
    crypto.randomUUID()
  );
  const [messages, setMessages] = useState([]);
  const storageKey = `tenant:${session.tenant?.id || ""}:user:${session.user.id}:conversation:${activeId || "new"}`;
  const setInput = (text, writeMode = "replace") =>
    window.dispatchEvent(
      new CustomEvent(PROMPT_INPUT_EVENT, {
        detail: { messageContent: text, writeMode },
      })
    );
  const focusInput = () =>
    window.document.getElementById(PROMPT_INPUT_ID)?.focus();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [processingAttachments, setProcessingAttachments] = useState(false);
  const [websocket, setWebsocket] = useState(null);
  const agentSocket = useRef(null);
  const [libraryChoices, setLibraryChoices] = useState(null);
  const libraryResolver = useRef(null);
  const appearance = useAppearance();
  const { chatHistoryRef: scrollApi } = useChatContainerQuickScroll();
  const { chatHistoryRef, isAtBottom, scrollToBottom, scrollHandlers } =
    useAutoScroll(messages, scrollApi, {
      disabled: appearance.disableAutoScroll,
    });
  const controller = useRef(null);
  const historyRequest = useRef({ generation: 0, controller: null });
  const sourceRequest = useRef({ generation: 0, controller: null });
  const mounted = useRef(true);

  async function refresh(signal) {
    try {
      const result = await api("/conversations", { signal });
      if (!mounted.current || signal?.aborted) return;
      setConversations(result.conversations || []);
    } catch (err) {
      if (mounted.current && err.name !== "AbortError") setError(err.message);
    }
  }
  useEffect(() => {
    mounted.current = true;
    const initial = new AbortController();
    refresh(initial.signal);
    api("/suggested-messages", { signal: initial.signal })
      .then((result) => {
        if (!initial.signal.aborted) setSuggestions(result.messages || []);
      })
      .catch(() => {});
    const initialConversation = new URLSearchParams(window.location.search).get(
      "conversationId"
    );
    if (initialConversation) select({ id: initialConversation });
    const halt = () => {
      controller.current?.abort();
      agentSocket.current?.close();
    };
    window.addEventListener(ABORT_STREAM_EVENT, halt);
    const processing = () => setProcessingAttachments(true);
    const processed = () => setProcessingAttachments(false);
    window.addEventListener(ATTACHMENTS_PROCESSING_EVENT, processing);
    window.addEventListener(ATTACHMENTS_PROCESSED_EVENT, processed);
    return () => {
      mounted.current = false;
      initial.abort();
      controller.current?.abort();
      agentSocket.current?.close();
      historyRequest.current.controller?.abort();
      sourceRequest.current.controller?.abort();
      libraryResolver.current?.(null);
      window.removeEventListener(ABORT_STREAM_EVENT, halt);
      window.removeEventListener(ATTACHMENTS_PROCESSING_EVENT, processing);
      window.removeEventListener(ATTACHMENTS_PROCESSED_EVENT, processed);
    };
  }, []);
  async function select(item) {
    if (streaming || processingAttachments || agentSocket.current) return;
    historyRequest.current.controller?.abort();
    const abort = new AbortController();
    const generation = ++historyRequest.current.generation;
    historyRequest.current.controller = abort;
    setLoading(true);
    setError("");
    try {
      const result = await api(
        `/conversations/${encodeURIComponent(item.id)}`,
        { signal: abort.signal }
      );
      if (
        !mounted.current ||
        abort.signal.aborted ||
        generation !== historyRequest.current.generation
      )
        return;
      setActiveId(item.id);
      activeConversation.current = item.id;
      setAttachmentScope(item.id);
      setMessages(result.messages || []);
      setInput("");
    } catch (err) {
      if (
        mounted.current &&
        !abort.signal.aborted &&
        generation === historyRequest.current.generation
      )
        setError(err.message);
    } finally {
      if (mounted.current && generation === historyRequest.current.generation)
        setLoading(false);
    }
  }
  function newChat() {
    if (streaming || processingAttachments || agentSocket.current) return;
    historyRequest.current.generation++;
    historyRequest.current.controller?.abort();
    setLoading(false);
    setActiveId(null);
    activeConversation.current = null;
    setAttachmentScope(crypto.randomUUID());
    setMessages([]);
    setInput("");
    setError("");
    focusInput();
  }
  function stop() {
    controller.current?.abort();
    agentSocket.current?.close();
  }
  async function ensureConversation(signal) {
    if (activeConversation.current) return activeConversation.current;
    if (!conversationCreation.current)
      conversationCreation.current = (async () => {
        const result = await api("/conversations", { method: "POST", signal });
        signal?.throwIfAborted();
        if (!mounted.current) throw new DOMException("Unmounted", "AbortError");
        activeConversation.current = result.conversation.id;
        setActiveId(result.conversation.id);
        setConversations((list) => [result.conversation, ...list]);
        return result.conversation.id;
      })().finally(() => {
        conversationCreation.current = null;
      });
    return conversationCreation.current;
  }
  function connectAgent(uuid) {
    const socket = new WebSocket(
      `${websocketURI()}/api/agent-invocation/${encodeURIComponent(uuid)}`
    );
    socket.supportsAgentStreaming = false;
    agentSocket.current = socket;
    setWebsocket(socket);
    setAgentSessionActive(true);
    setAgentSessionSocket(socket);
    window.dispatchEvent(new CustomEvent(AGENT_SESSION_START));
    socket.onopen = () =>
      socket.send(
        JSON.stringify({
          type: "authenticate",
          token: localStorage.getItem(TOKEN_KEY),
        })
      );
    socket.onmessage = (event) => {
      try {
        const state = agentEventLoadingState(JSON.parse(event.data));
        if (state !== null) setStreaming(state);
        handleSocketResponse(socket, event, setMessages);
      } catch {
        socket.close();
        setError("Agent 返回了无效消息");
      }
    };
    socket.onerror = () => setError("Agent 连接失败，请重试");
    socket.onclose = () => {
      if (agentSocket.current === socket) agentSocket.current = null;
      setAgentSessionActive(false);
      setAgentSessionSocket(null);
      window.dispatchEvent(new CustomEvent(AGENT_SESSION_END));
      if (!mounted.current) return;
      setWebsocket(null);
      setStreaming(false);
      refresh();
      if (mounted.current && activeConversation.current)
        reloadMessages(activeConversation.current).catch((error) =>
          setError(error.message)
        );
    };
  }
  const resourceApi = useMemo(
    () => ({
      prepareForUpload: () => ensureConversation(),
      getParsedFiles: async () =>
        activeConversation.current
          ? api(
              `/conversations/${encodeURIComponent(activeConversation.current)}/parsed-files`
            )
          : { files: [], contextWindow: 0, currentContextTokenCount: 0 },
      parseFile: async (_key, form) => {
        try {
          const id = await ensureConversation();
          const data = await api(
            `/conversations/${encodeURIComponent(id)}/parse`,
            { method: "POST", body: form }
          );
          return { response: { ok: true }, data };
        } catch (error) {
          return { response: { ok: false }, data: { error: error.message } };
        }
      },
      deleteParsedFiles: async (_key, fileIds) => {
        const id = activeConversation.current;
        if (!id) return false;
        await api(`/conversations/${encodeURIComponent(id)}/parsed-files`, {
          method: "DELETE",
          body: { fileIds },
        });
        return true;
      },
      saveParsedFiles: async (fileIds) => {
        const { libraries } = await api("/libraries");
        if (!libraries.length) throw new Error("请先创建知识库");
        const libraryId = await new Promise((resolve) => {
          libraryResolver.current = resolve;
          setLibraryChoices(libraries);
        });
        if (!libraryId) throw new Error("已取消保存");
        const id = activeConversation.current;
        if (!id) throw new Error("会话已结束");
        for (const fileId of fileIds)
          await api(
            `/conversations/${encodeURIComponent(id)}/parsed-files/${fileId}/save`,
            { method: "POST", body: { libraryId } }
          );
      },
      embedParsedFile: async (_key, fileId) => {
        try {
          await resourceApi.saveParsedFiles([fileId]);
          return { response: { ok: true } };
        } catch (error) {
          setError(error.message);
          return { response: { ok: false } };
        }
      },
    }),
    []
  );
  const loadCapabilities = useMemo(() => () => api("/chat/capabilities"), []);
  async function remove(item) {
    if (!window.confirm(`删除对话“${item.title || "新对话"}”？`)) return;
    try {
      await api(`/conversations/${encodeURIComponent(item.id)}`, {
        method: "DELETE",
      });
      if (!mounted.current) return;
      if (String(activeId) === String(item.id)) newChat();
      await refresh();
    } catch (err) {
      setError(err.message);
    }
  }
  async function rename(item, title) {
    try {
      await api(`/conversations/${encodeURIComponent(item.id)}`, {
        method: "PATCH",
        body: { title },
      });
      if (mounted.current) await refresh();
    } catch (err) {
      if (mounted.current) setError(err.message);
    }
  }
  async function send(event, suppliedText, attachments = []) {
    event?.preventDefault();
    const text = (
      suppliedText ?? window.document.getElementById(PROMPT_INPUT_ID)?.value
    )?.trim();
    if (!text || streaming || loading) return;
    if (agentSocket.current?.readyState === WebSocket.OPEN) {
      setMessages((list) => [
        ...list,
        { role: "user", content: text, attachments, uuid: crypto.randomUUID() },
      ]);
      agentSocket.current.send(
        JSON.stringify({
          type: "awaitingFeedback",
          feedback: text,
          attachments,
          reasoningEffort: getSessionReasoningEffort(storageKey),
        })
      );
      setInput("");
      setStreaming(true);
      window.dispatchEvent(new CustomEvent(CLEAR_ATTACHMENTS_EVENT));
      return;
    }
    setStreaming(true);
    setError("");
    clearPromptInputDraft(storageKey);
    setInput("");
    const abort = new AbortController();
    controller.current = abort;
    const assistantId = `pending-${Date.now()}`;
    const userId = `user-${crypto.randomUUID()}`;
    const history = [...messages];
    const previous = [
      ...history,
      {
        id: userId,
        uuid: userId,
        role: "user",
        content: text,
        attachments,
        pending: true,
      },
    ];
    const responseHistory = [
      ...previous,
      {
        id: assistantId,
        uuid: assistantId,
        role: "assistant",
        content: "",
        sources: [],
        pending: true,
      },
    ];
    try {
      const id = await ensureConversation(abort.signal);
      setMessages(responseHistory);
      await streamMessage(
        id,
        text,
        (event) => {
          if (!mounted.current || abort.signal.aborted) return;
          if (event.type === "finalizeResponseStream" && event.message) {
            const message =
              typeof event.message === "string"
                ? { content: event.message }
                : event.message;
            const chatId = event.chatId || message.id || null;
            handleChat(
              {
                ...event,
                ...message,
                type: "textResponse",
                uuid: assistantId,
                textResponse: message.content || "",
                chatId,
                close: true,
              },
              () => {},
              (list) =>
                setMessages(
                  list.map((item) => ({
                    ...item,
                    id:
                      item.role === "user" && item.id === userId && chatId
                        ? `${chatId}:user`
                        : item.id || item.uuid,
                    ...(item.uuid === assistantId || item.id === userId
                      ? { chatId, pending: false, ephemeral: !chatId }
                      : {}),
                  }))
                ),
              previous,
              responseHistory,
              connectAgent
            );
            return;
          }
          handleChat(
            {
              ...event,
              uuid:
                event.type === "modelRouteNotification"
                  ? event.uuid
                  : assistantId,
            },
            () => {},
            setMessages,
            previous,
            responseHistory,
            connectAgent
          );
        },
        abort.signal,
        {
          attachments,
          reasoningEffort: getSessionReasoningEffort(storageKey),
          agentTransport: "websocket",
        }
      );
      window.dispatchEvent(new CustomEvent(CLEAR_ATTACHMENTS_EVENT));
      await refresh(abort.signal);
    } catch (err) {
      if (!mounted.current) return;
      if (err.name === "AbortError")
        setError("已停止接收本次回答。您可以继续提问。");
      else {
        setError(err.message);
        setInput(text);
      }
      setMessages((list) =>
        list.map((item) =>
          item.id === assistantId
            ? {
                ...item,
                content:
                  err.name === "AbortError"
                    ? "本次生成已停止。"
                    : "暂时未能生成回答，请查看上方提示后重试。",
                sources: [],
                failed: true,
                type: "chat",
                pending: false,
              }
            : item
        )
      );
    } finally {
      if (mounted.current) {
        if (!agentSocket.current) setStreaming(false);
        controller.current = null;
        focusInput();
      }
    }
  }
  useEffect(() => {
    onNavigation?.({
      conversations,
      onRename: rename,
      activeId,
      streaming,
      loading: loading || processingAttachments,
      onSelect: select,
      onNew: newChat,
      onRemove: remove,
      onStop: stop,
    });
  }, [
    conversations,
    activeId,
    streaming,
    loading,
    processingAttachments,
    onNavigation,
  ]);
  useEffect(() => () => onNavigation?.(null), [onNavigation]);

  async function reloadMessages(id = activeId) {
    const result = await api(`/conversations/${encodeURIComponent(id)}`);
    if (mounted.current && activeConversation.current === id)
      setMessages(result.messages || []);
  }
  async function deleteChat(chatId) {
    try {
      await api(`/messages/${encodeURIComponent(chatId)}`, {
        method: "DELETE",
      });
    } catch (err) {
      setError(err.message);
    }
  }
  async function updateFeedback(chatId, feedbackScore) {
    try {
      await api(`/messages/${encodeURIComponent(chatId)}/feedback`, {
        method: "POST",
        body: { feedbackScore },
      });
    } catch (err) {
      setError(err.message);
      throw err;
    }
  }
  async function saveEditedMessage({
    chatId,
    role,
    editedMessage,
    attachments = [],
    saveOnly = false,
  }) {
    try {
      if (role === "user" && !saveOnly) {
        await api(`/messages/${encodeURIComponent(chatId)}/truncate`, {
          method: "POST",
          body: {},
        });
        await reloadMessages();
        await send(undefined, editedMessage, attachments);
      } else {
        await api(`/messages/${encodeURIComponent(chatId)}`, {
          method: "PATCH",
          body: { role, content: editedMessage },
        });
        await reloadMessages();
      }
    } catch (err) {
      setError(err.message);
    }
  }
  async function regenerateMessage(chatId) {
    if (streaming) return;
    try {
      const result = await api(
        `/messages/${encodeURIComponent(chatId)}/truncate`,
        { method: "POST", body: { regenerate: true } }
      );
      await reloadMessages();
      await send(undefined, result.prompt, result.attachments || []);
    } catch (err) {
      setError(err.message);
    }
  }
  async function forkThread(chatId) {
    try {
      const result = await api(`/messages/${encodeURIComponent(chatId)}/fork`, {
        method: "POST",
        body: {},
      });
      await refresh();
      await select(result.conversation);
    } catch (err) {
      setError(err.message);
    }
  }
  async function source(item) {
    sourceRequest.current.controller?.abort();
    const abort = new AbortController();
    const generation = ++sourceRequest.current.generation;
    sourceRequest.current.controller = abort;
    setError("");
    try {
      const result = await api(
        item.parsedFileId
          ? `/conversations/${encodeURIComponent(activeId)}/parsed-files/${encodeURIComponent(item.parsedFileId)}`
          : `/documents/${encodeURIComponent(item.documentId)}`,
        { signal: abort.signal }
      );
      if (
        !mounted.current ||
        abort.signal.aborted ||
        generation !== sourceRequest.current.generation
      )
        return;
      return result.document;
    } catch (err) {
      if (
        mounted.current &&
        !abort.signal.aborted &&
        generation === sourceRequest.current.generation
      )
        setError(`无法查看此来源：${err.message}`);
    }
  }
  const inputView = (centered) => (
    <PersonalPromptInput
      submit={send}
      sendCommand={({
        text = "",
        writeMode = "replace",
        autoSubmit = false,
        attachments = [],
      }) => {
        if (autoSubmit) {
          const current =
            window.document.getElementById(PROMPT_INPUT_ID)?.value || "";
          const combined =
            writeMode === "append"
              ? current + text
              : writeMode === "prepend"
                ? text + " " + current
                : text;
          if (streaming || loading) setInput(combined);
          else send(undefined, combined, attachments);
        } else setInput(text, writeMode);
        focusInput();
      }}
      isStreaming={streaming}
      disabled={loading}
      sendLabel={t("enterprise:shortcuts.send")}
      storageKey={storageKey}
      workspaceSlug={storageKey}
      resourceApi={resourceApi}
      loadCapabilities={loadCapabilities}
      capabilities={{
        tools: true,
        attachments: true,
        reasoning: true,
      }}
      centered={centered}
    />
  );
  const compiledHistory = buildMessages({
    history: messages.map((message, index) => ({
      ...message,
      content: message.content || "",
      uuid: String(message.id || message.uuid || index),
      chatId:
        message.pending || message.failed || message.ephemeral
          ? null
          : message.chatId ||
            (message.id ? String(message.id).replace(/:user$/, "") : null),
    })),
    regenerateAssistantMessage: regenerateMessage,
    saveEditedMessage,
    forkThread,
    websocket,
    updateFeedback,
    fetchTTSAudio: ttsMessage,
    isStreaming: streaming,
  });
  return (
    <DnDFileUploaderProvider
      scopeKey={attachmentScope}
      resourceApi={resourceApi}
    >
      <DnDFileUploaderWrapper>
        <div
          style={{ height: "calc(100% - 32px)" }}
          className="relative flex md:ml-[2px] md:mr-[16px] md:my-[16px] w-full h-full z-[2]"
        >
          <section className="flex-1 min-w-0 relative md:rounded-[16px] bg-zinc-900 light:bg-white text-white light:text-slate-900 h-full overflow-hidden border-none light:border-solid light:border light:border-theme-modal-border flex flex-col">
            <ChatSettingsMenu
              history={messages}
              onExport={
                activeId
                  ? (type) =>
                      exportConversation(activeId, type).catch((error) => {
                        setError(error.message);
                        return null;
                      })
                  : null
              }
              chatUrl={
                activeId
                  ? `${window.location.origin}/chat?conversationId=${encodeURIComponent(activeId)}`
                  : null
              }
            />
            <div className="px-5 pt-2 [&:empty]:hidden">
              <Notice onClose={() => setError("")}>{error}</Notice>
            </div>
            {loading ? (
              <div className="flex flex-1 items-center justify-center text-theme-text-secondary">
                {t("enterprise:chat.loading")}
              </div>
            ) : !messages.length ? (
              <div className="flex flex-col flex-1 w-full items-center justify-center px-4">
                <div className="flex flex-col items-center w-full max-w-[750px]">
                  <h1 className="text-white light:text-slate-900 text-2xl md:text-[32px] md:leading-10 mb-11 text-center">
                    {greeting}
                  </h1>
                  {inputView(true)}
                </div>
                <SuggestedMessages
                  suggestedMessages={suggestions}
                  sendCommand={({ text, autoSubmit }) => {
                    if (autoSubmit) send(null, text);
                    else {
                      setInput(text);
                      focusInput();
                    }
                  }}
                />
              </div>
            ) : (
              <>
                <div
                  ref={chatHistoryRef}
                  {...scrollHandlers}
                  className={`min-h-0 flex-1 overflow-y-auto w-full ${appearance.showScrollbar ? "" : "no-scroll"}`}
                >
                  <MessageActionsProvider
                    key={activeId}
                    deleteChat={deleteChat}
                  >
                    <div className="mx-auto max-w-[750px] w-full px-4 py-4">
                      <ThoughtExpansionProvider>
                        {compiledHistory.map((item, index) =>
                          Array.isArray(item) ? (
                            <StatusResponse
                              key={item[0]?.uuid || index}
                              messages={item}
                              isLastGroup={index === compiledHistory.length - 1}
                              isThinking={
                                index === compiledHistory.length - 1 &&
                                streaming
                              }
                            />
                          ) : (
                            item
                          )
                        )}
                      </ThoughtExpansionProvider>
                    </div>
                  </MessageActionsProvider>
                </div>
                {!isAtBottom && (
                  <button
                    type="button"
                    onClick={() => scrollToBottom(true)}
                    aria-label="滚动到底部"
                    className="absolute bottom-44 right-8 rounded-full bg-theme-bg-primary p-2 text-theme-text-secondary border border-theme-sidebar-border"
                  >
                    <ArrowDown size={20} />
                  </button>
                )}
                <div className="px-4">{inputView(false)}</div>
              </>
            )}
          </section>
          <MemoriesSidebar />
          <SourcesSidebar
            onSourceOpen={async (combined, sources) => {
              const matching = sources.filter(
                (item) => item.title === combined.title
              );
              const authorized = [];
              for (const item of matching) {
                if (!item.documentId && !item.parsedFileId) {
                  authorized.push(item);
                  continue;
                }
                const document = await source(item);
                if (!document) return null;
                authorized.push({
                  ...item,
                  text: item.text || document.content || "",
                });
              }
              return { ...combined, chunks: authorized };
            }}
          />
          {libraryChoices && (
            <Modal
              title="保存到知识库"
              onClose={() => {
                libraryResolver.current?.(null);
                setLibraryChoices(null);
              }}
            >
              <div className="flex flex-col gap-2">
                {libraryChoices.map((library) => (
                  <button
                    key={library.id}
                    className="text-left p-3 rounded bg-theme-bg-secondary text-theme-text-primary"
                    onClick={() => {
                      libraryResolver.current?.(library.id);
                      setLibraryChoices(null);
                    }}
                  >
                    {library.name}
                    {library.visibility === "public"
                      ? "（公有，提交审批）"
                      : "（私有）"}
                  </button>
                ))}
              </div>
            </Modal>
          )}
        </div>
      </DnDFileUploaderWrapper>
    </DnDFileUploaderProvider>
  );
}

function PersonalPromptInput({ submit, ...props }) {
  const { files, parseAttachments } = useContext(DndUploaderContext);
  return (
    <PromptInput
      {...props}
      sendCommand={(options) =>
        props.sendCommand({ ...options, attachments: parseAttachments() })
      }
      attachments={files}
      submit={(event) => submit(event, undefined, parseAttachments())}
    />
  );
}
