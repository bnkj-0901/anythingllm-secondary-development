const { EventEmitter } = require("events");
const { providerClass, upstreamName } = require("./provider-config");
const { runConnection } = require("./connection-context");
const { safeError, providerError } = require("./errors");

function providerFor(connection, kind) {
  const Class = providerClass(connection.provider, kind);
  if (!Class) throw providerError(400, "连接类型或供应商无效");
  return Class;
}

function chatConnector(connection) {
  const Class = providerFor(connection, "chat");
  const provider = upstreamName(connection.provider);
  if (connection.resolvedProvider) return connection.resolvedProvider;
  // Chat uses the separately resolved tenant embedding connection for RAG.
  const model =
    provider === "azure"
      ? connection.config.options?.deployment || connection.config.model
      : connection.config.model;
  const connector = new Class({}, model);
  const { resolveTemperature } = require("../../utils/helpers");
  connector.temperature = resolveTemperature(
    provider,
    connector.model,
    connection.config.options?.temperature
  );
  return connector;
}

async function prepareChatConnection(connection, options = {}) {
  return runConnection(connection, options, async () => {
    let connector;
    if (
      upstreamName(connection.provider) === "anythingllm-router" ||
      options.configuration?.chatProvider === "anythingllm-router"
    ) {
      const {
        AnythingLLMModelRouter,
      } = require("../../utils/AiProviders/modelRouter");
      const configuration = {
        ...options.configuration,
        router_id:
          options.configuration?.router_id ||
          Number(process.env.MODEL_ROUTER_ID),
      };
      connector = new AnythingLLMModelRouter(configuration);
      const context =
        await require("../../utils/router").ModelRouterService.gatherRoutingContext(
          {
            ctx: options.ctx,
            configuration,
            thread: options.thread,
            message: options.prompt || "",
          }
        );
      await connector.resolve(
        {
          prompt: options.prompt || "",
          conversationTokenCount: context.conversationTokenCount,
          conversationMessageCount: context.conversationMessageCount,
          attachments: options.attachments || [],
        },
        { ctx: options.ctx, user: options.ctx?.user, thread: options.thread }
      );
    } else {
      const selected = options.configuration;
      const model = options.model || selected?.chatModel;
      connector =
        model || selected?.chatProvider
          ? require("../../utils/helpers").getLLMProvider({
              provider:
                selected?.chatProvider || upstreamName(connection.provider),
              model,
              temperature: options.temperature ?? selected?.openAiTemp,
            })
          : chatConnector(connection);
    }
    await connector.assertModelContextLimits?.();
    options.signal?.throwIfAborted();
    const contextWindow = Number(connector.promptWindowLimit());
    if (!Number.isFinite(contextWindow) || contextWindow <= 0)
      throw providerError(422, "模型上下文窗口无效，请核对原模型配置");
    return {
      ...connection,
      contextWindow,
      resolvedProvider: connector,
      config: {
        ...connection.config,
        model: connector.model || connection.config.model,
      },
    };
  });
}

// Reuse each provider's stream decoder, reasoning extraction and performance
// monitor. Only translate its original SSE response into the product callback.
class StreamResponse extends EventEmitter {
  constructor(onToken, onEvent, stop) {
    super();
    this.onToken = onToken;
    this.onEvent = onEvent;
    this.writableEnded = false;
    this.destroyed = false;
    this.error = null;
    this.pending = Promise.resolve();
    this.stop = stop;
  }

  write(chunk) {
    if (this.writableEnded || this.destroyed) return false;
    for (const line of String(chunk).split("\n")) {
      if (!line.startsWith("data: ")) continue;
      const event = JSON.parse(line.slice(6));
      if (event.error)
        this.error = providerError(502, "模型服务在生成过程中返回错误");
      // Original decoders require synchronous write(). Observe every callback
      // immediately, serialize authorization checks, and drain before returning.
      this.pending = this.pending
        .then(async () => {
          if (this.error || this.destroyed) return;
          await this.onEvent?.(event);
          if (typeof event.textResponse === "string" && event.textResponse)
            await this.onToken?.(event.textResponse);
        })
        .catch((error) => {
          this.error ||= error;
          this.stop();
        });
    }
    return true;
  }
}

async function complete(connection, messages, onToken, options = {}) {
  providerFor(connection, "chat");
  return runConnection(connection, options, async () => {
    try {
      options.signal?.throwIfAborted();
      const connector = chatConnector(connection);
      await connector.assertModelContextLimits?.();
      const parameters = {
        ...connection.config.options,
        temperature:
          connector.temperature ?? connection.config.options?.temperature,
      };
      let stream;
      const abort = () => {
        response.destroyed = true;
        response.emit("close");
        stream?.controller?.abort();
      };
      const response = new StreamResponse(onToken, options.onEvent, abort);
      options.signal?.addEventListener("abort", abort, { once: true });
      try {
        // The caller can cancel while the SDK is still opening its stream.
        if (options.signal?.aborted) abort();
        options.signal?.throwIfAborted();
        const result =
          await require("../../utils/chats/stream").generateChatResponse({
            connector,
            messages,
            response: onToken ? response : null,
            user: options.ctx?.user || null,
            configuration: {
              chatProvider: upstreamName(connection.provider),
              ...options.configuration,
            },
            parameters,
            sessionReasoningEffort: options.reasoningEffort,
            signal: options.signal,
            onStream: (value) => {
              stream = value;
              if (options.signal?.aborted) abort();
            },
          });
        response.writableEnded = true;
        await response.pending;
        options.signal?.throwIfAborted();
        if (response.error) throw response.error;
        if (typeof result.textResponse !== "string")
          throw providerError(502, "模型服务返回的回答无效");
        options.onMetrics?.(result.metrics);
        return result.textResponse;
      } finally {
        response.writableEnded = true;
        await response.pending;
        options.signal?.removeEventListener("abort", abort);
        response.removeAllListeners();
      }
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason;
      throw safeError(error);
    }
  });
}

async function compress(connection, promptArgs, rawHistory = []) {
  return runConnection(connection, {}, async () =>
    require("../../utils/chats/stream").compressChatMessages(
      chatConnector(connection),
      promptArgs,
      rawHistory
    )
  );
}

async function embed(connection, texts, options = {}) {
  const Class = providerFor(connection, "embedding");
  return runConnection(connection, options, async () => {
    try {
      options.signal?.throwIfAborted();
      const connector = new Class();
      const prefix = options.query
        ? connector.queryPrefix || ""
        : connector.embeddingPrefix || "";
      const result = await connector.embedChunks(
        texts.map((text) => prefix + text)
      );
      options.signal?.throwIfAborted();
      return result;
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason;
      throw safeError(error);
    }
  });
}

module.exports = { complete, compress, embed, prepareChatConnection };
