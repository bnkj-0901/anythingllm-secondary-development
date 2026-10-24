/* global jest, test, expect, afterEach */
jest.mock("../../utils/AiProviders/modelMap", () => ({
  MODEL_MAP: {
    get: jest.fn((_provider, model) => (model === "known-model" ? 8192 : null)),
  },
}));

const {
  env,
  runConnection,
  runWithEnvironment,
  scopedFetch,
  sdkOptions,
  scopedCache,
  scopedCacheFolder,
  inConnectionScope,
} = require("../../enterprise/ai/connection-context");
const { embeddingChunkLimit } = require("../../enterprise/ai/options");
const { safeError, providerError } = require("../../enterprise/ai/errors");
const runtime = require("../../enterprise/ai/runtime");
const { GenericOpenAiLLM } = require("../../utils/AiProviders/genericOpenAi");
const { NativeEmbedder } = require("../../utils/EmbeddingEngines/native");
const { spawnSync } = require("child_process");
const path = require("path");

const connection = (id = "a", overrides = {}) => ({
  id,
  version: 1,
  provider: "openai-compatible",
  kind: "chat",
  config: {
    model: "known-model",
    baseUrl: `https://${id}.example.test/v1`,
    apiKey: `private-${id}`,
    headers: { "x-private-key": `header-${id}` },
    options: { contextWindow: 4096, maxTokens: 128 },
  },
  ...overrides,
});
afterEach(() => jest.restoreAllMocks());

test("parallel and nested calls isolate environment writes, enumeration and request caches", async () => {
  const original = new Map([["global", "must stay outside tenant calls"]]);
  const originalSet = new Set(["global"]);
  const originalObject = { global: "not shared" };
  const snapshots = await Promise.all(
    ["a", "b"].map((id) =>
      runConnection(connection(id), {}, async () => {
        expect(inConnectionScope()).toBe(true);
        expect(env.GENERIC_OPEN_AI_API_KEY).toBe(`private-${id}`);
        env.LOCAL_TRANSIENT = id;
        await new Promise((resolve) => setImmediate(resolve));
        expect(Object.keys(env)).toContain("LOCAL_TRANSIENT");
        expect(
          Object.getOwnPropertyDescriptor(env, "LOCAL_TRANSIENT").value
        ).toBe(id);
        expect(
          Object.getOwnPropertyDescriptor(env, "MISSING_KEY")
        ).toBeUndefined();
        const map = scopedCache(original);
        const set = scopedCache(originalSet);
        const object = scopedCache(originalObject);
        expect(map.size).toBe(0);
        expect(set.size).toBe(0);
        expect(object.global).toBeUndefined();
        map.set("tenant", id);
        set.add(id);
        object.tenant = id;
        await runWithEnvironment({ LOCAL_TRANSIENT: "nested" }, async () => {
          expect(env.LOCAL_TRANSIENT).toBe("nested");
          expect(env.GENERIC_OPEN_AI_API_KEY).toBeUndefined();
          expect(scopedCache(original).size).toBe(0);
        });
        expect(env.LOCAL_TRANSIENT).toBe(id);
        expect(scopedCache(original)).toBe(map);
        delete env.LOCAL_TRANSIENT;
        expect("LOCAL_TRANSIENT" in env).toBe(false);
        return [map.get("tenant"), [...set], object.tenant];
      })
    )
  );
  expect(snapshots).toEqual([
    ["a", ["a"], "a"],
    ["b", ["b"], "b"],
  ]);
  expect(original.size).toBe(1);
  expect(originalSet.size).toBe(1);
  expect(originalObject).toEqual({ global: "not shared" });
  expect(scopedCache(original)).toBe(original);
  expect(inConnectionScope()).toBe(false);
});

test("connection cache paths change with credentials and version without exposing credentials", () => {
  const first = connection();
  const rotated = { ...first, config: { ...first.config, apiKey: "rotated" } };
  const upgraded = { ...first, version: 2 };
  const paths = [first, rotated, upgraded].map((value) =>
    runConnection(value, {}, () => scopedCacheFolder("cache"))
  );
  expect(new Set(paths).size).toBe(3);
  expect(paths.join(" ")).not.toMatch(/private-a|rotated/);
  expect(scopedCacheFolder("cache")).toBe("cache");
});

test("request scope preserves original endpoint and never injects unrelated private headers", async () => {
  const fetchImpl = jest.fn(async () => new Response("ok"));
  await runConnection(connection("a", { provider: "openai" }), {}, () =>
    scopedFetch(
      "https://api.openai.com/v1/models",
      { headers: { public: "kept" } },
      fetchImpl
    )
  );
  expect(fetchImpl.mock.calls[0][0]).toBe("https://api.openai.com/v1/models");
  expect(fetchImpl.mock.calls[0][1].headers).toEqual({ public: "kept" });
});

test("request cancellation and connection timeout both abort the fetch without leaking into peers", async () => {
  const connectionAbort = new AbortController();
  const requestAbort = new AbortController();
  const value = connection();
  const fetchImpl = jest.fn(async (_input, init) => {
    const aborted = new Promise((resolve) =>
      init.signal.addEventListener("abort", () => resolve(init.signal.reason), {
        once: true,
      })
    );
    requestAbort.abort(new Error("cancel request"));
    return aborted;
  });
  expect(
    await runConnection(value, { signal: connectionAbort.signal }, () =>
      scopedFetch(
        value.config.baseUrl,
        { signal: requestAbort.signal },
        fetchImpl
      )
    )
  ).toMatchObject({ message: "cancel request" });
  const timed = connection();
  timed.config.options.timeoutMs = 5;
  const timerFetch = (_input, init) =>
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 1000);
      init.signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve(init.signal.reason);
        },
        { once: true }
      );
    });
  expect(
    await runConnection(timed, {}, () =>
      scopedFetch(timed.config.baseUrl, {}, timerFetch)
    )
  ).toMatchObject({ name: "TimeoutError" });
  await runConnection(connection("peer"), {}, async () => {
    const peerFetch = jest.fn(async () => null);
    await scopedFetch("https://peer.example.test/v1", {}, peerFetch);
    expect(peerFetch.mock.calls[0][1].signal).toBeUndefined();
  });
});

test.each([
  "openai",
  "anthropic",
  "gemini",
  "azure",
  "voyage",
  "bedrock",
  "ollama",
])(
  "SDK %s keeps upstream endpoint/header options while accepting request cancellation",
  (provider) => {
    const original = {
      baseURL: "original",
      defaultHeaders: { public: "kept" },
      headers: { Authorization: "original" },
    };
    expect(sdkOptions(original)).toBe(original);
    runConnection(connection("a", { provider }), {}, () => {
      expect(sdkOptions(original)).toMatchObject(original);
      expect(sdkOptions(original).fetch).toEqual(expect.any(Function));
    });
  }
);

test("context budgets use the original provider limit and native chunk ceilings", async () => {
  let value = connection();
  delete value.config.options;
  expect((await runtime.prepareChatConnection(value)).contextWindow).toBe(4096);
  value = connection();
  value.config.options = { contextWindow: 2048 };
  expect((await runtime.prepareChatConnection(value)).contextWindow).toBe(2048);
  value.provider = "openai";
  // OpenAI owns the model map; a generic custom-window setting must not
  // override a fixed provider whose own implementation ignores that option.
  expect((await runtime.prepareChatConnection(value)).contextWindow).toBe(8192);
  value = connection();
  value.provider = "native";
  value.config.model = "Xenova/nomic-embed-text-v1";
  value.config.options = { maxChunkLength: 100000 };
  expect(embeddingChunkLimit(value)).toBe(16000);
  value.config.options.maxChunkLength = 500;
  expect(embeddingChunkLimit(value)).toBe(500);
  value.config.model = "missing-model";
  delete value.config.options;
  expect(embeddingChunkLimit(value)).toBe(1000);
  value.provider = "missing-provider";
  expect(() => embeddingChunkLimit(value)).toThrow();
});

test.each([
  [{ status: 401 }, 502, "认证"],
  [{ status: 403 }, 502, "认证"],
  [{ status: 404 }, 502, "不存在"],
  [{ status: 429 }, 502, "限流"],
  [{ status: 503 }, 502, "HTTP 503"],
  [{ name: "TimeoutError" }, 504, "超时"],
  [{ name: "AbortError" }, 504, "超时"],
  [{ message: "upstream timeout: private-token" }, 504, "超时"],
  [{}, 502, "网络"],
])(
  "provider failures %j expose an actionable message with no credential details",
  (details, status, message) => {
    const failure = safeError({
      message: "private-token https://private.example",
      ...details,
    });
    expect(failure.status).toBe(status);
    expect(failure.message).toContain(message);
    expect(failure.message).not.toMatch(/private-token|private\.example/);
    expect(failure.enterpriseProvider).toBe(true);
  }
);

test("permission guards and already sanitized provider failures preserve their status", () => {
  const guard = Object.assign(new Error("source access revoked"), {
    status: 403,
    enterpriseGuard: true,
  });
  const provider = providerError(422, "model discovery unsupported");
  expect(safeError(guard)).toBe(guard);
  expect(safeError(provider)).toBe(provider);
});

test("pre-canceled generation and embedding never invoke the provider and preserve the caller reason", async () => {
  const controller = new AbortController();
  const reason = new Error("caller canceled");
  controller.abort(reason);
  const chat = jest.spyOn(GenericOpenAiLLM.prototype, "getChatCompletion");
  const embedding = jest.spyOn(NativeEmbedder.prototype, "embedChunks");
  await expect(
    runtime.complete(connection(), [], undefined, { signal: controller.signal })
  ).rejects.toBe(reason);
  await expect(
    runtime.embed(
      connection("native", { provider: "native", kind: "embedding" }),
      ["text"],
      { signal: controller.signal }
    )
  ).rejects.toBe(reason);
  expect(chat).not.toHaveBeenCalled();
  expect(embedding).not.toHaveBeenCalled();
});

test("malformed completion cannot become a saved answer; disabled streaming still invokes the callback", async () => {
  const completion = jest.spyOn(
    GenericOpenAiLLM.prototype,
    "getChatCompletion"
  );
  completion.mockResolvedValueOnce({ textResponse: null });
  await expect(runtime.complete(connection(), [])).rejects.toMatchObject({
    status: 502,
    message: "模型服务返回的回答无效",
  });
  completion.mockResolvedValueOnce({
    textResponse: "complete answer",
    metrics: { total_tokens: 4 },
  });
  const value = connection();
  value.config.options.streamingDisabled = true;
  const tokens = [],
    metrics = [];
  await expect(
    runtime.complete(value, [], (token) => tokens.push(token), {
      onMetrics: (metric) => metrics.push(metric),
    })
  ).resolves.toBe("complete answer");
  expect(tokens).toEqual(["complete answer"]);
  expect(metrics).toEqual([{ total_tokens: 4 }]);
});

test("original stream decoder drains asynchronous callbacks before caller cleanup without unhandled rejections", () => {
  // A separate strict process reproduces production's fatal rejection behavior.
  // Keep the original decoder; only replace its upstream iterator with a fixture.
  const script = `
    const assert = require("assert/strict");
    const runtime = require("./server/enterprise/ai/runtime");
    const { GenericOpenAiLLM } = require("./server/utils/AiProviders/genericOpenAi");
    GenericOpenAiLLM.prototype.streamGetChatCompletion = async () => {
      const stream = (async function* () {
        yield { choices: [{ delta: { content: "first" } }] };
        yield { choices: [{ delta: { content: "second" } }] };
        yield { choices: [{ delta: {}, finish_reason: "stop" }] };
      })();
      stream.endMeasurement = () => {};
      return stream;
    };
    const connection = ${JSON.stringify(connection())};
    (async () => {
      const controller = new AbortController();
      const tokens = [];
      let active = 0;
      const text = await runtime.complete(connection, [], async (token) => {
        assert.equal(++active, 1, "token authorization must run in order");
        await new Promise((resolve) => setTimeout(resolve, token === "first" ? 20 : 1));
        controller.signal.throwIfAborted();
        tokens.push(token);
        active--;
      }, { signal: controller.signal });
      // RAG's route aborts its request scope in finally after complete returns.
      controller.abort();
      await new Promise((resolve) => setTimeout(resolve, 40));
      assert.equal(text, "firstsecond");
      assert.deepEqual(tokens, ["first", "second"]);
    })().catch((error) => { console.error(error); process.exitCode = 1; });
  `;
  const result = spawnSync(
    process.execPath,
    ["--unhandled-rejections=strict", "-e", script],
    {
      cwd: path.resolve(__dirname, "../../.."),
      encoding: "utf8",
      timeout: 15000,
    }
  );
  expect(result.error).toBeUndefined();
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
});

test("asynchronous stream guards stop generation, preserve the permission failure, and skip queued callbacks", async () => {
  const abort = jest.fn();
  const stream = { controller: { abort } };
  const guard = Object.assign(new Error("source access revoked"), {
    status: 403,
    enterpriseGuard: true,
  });
  jest
    .spyOn(GenericOpenAiLLM.prototype, "streamGetChatCompletion")
    .mockResolvedValue(stream);
  jest
    .spyOn(GenericOpenAiLLM.prototype, "handleStream")
    .mockImplementation((response) => {
      for (const textResponse of ["first", "second"])
        response.write(`data: ${JSON.stringify({ textResponse })}\n\n`);
      return new Promise((resolve) =>
        response.once("close", () => resolve(""))
      );
    });
  const callback = jest.fn(async () => {
    await Promise.resolve();
    throw guard;
  });
  await expect(runtime.complete(connection(), [], callback)).rejects.toBe(
    guard
  );
  expect(callback).toHaveBeenCalledTimes(1);
  expect(abort).toHaveBeenCalledTimes(1);
});

test("cancellation while the SDK opens a stream stops the returned stream without decoding", async () => {
  const controller = new AbortController();
  const reason = new Error("caller canceled while opening stream");
  const abort = jest.fn();
  jest
    .spyOn(GenericOpenAiLLM.prototype, "streamGetChatCompletion")
    .mockImplementation(async () => {
      controller.abort(reason);
      return { controller: { abort } };
    });
  const decode = jest.spyOn(GenericOpenAiLLM.prototype, "handleStream");
  await expect(
    runtime.complete(connection(), [], jest.fn(), { signal: controller.signal })
  ).rejects.toBe(reason);
  expect(abort).toHaveBeenCalledTimes(1);
  expect(decode).not.toHaveBeenCalled();
});

test("disabled streaming waits for asynchronous token authorization and propagates its rejection", async () => {
  jest
    .spyOn(GenericOpenAiLLM.prototype, "getChatCompletion")
    .mockResolvedValue({ textResponse: "complete answer" });
  const value = connection();
  value.config.options.streamingDisabled = true;
  const guard = Object.assign(new Error("source access revoked"), {
    status: 403,
    enterpriseGuard: true,
  });
  await expect(
    runtime.complete(value, [], async () => {
      await Promise.resolve();
      throw guard;
    })
  ).rejects.toBe(guard);
});

test("SDK errors from an embedder are sanitized and late cancellation discards its result", async () => {
  const value = connection("native", { provider: "native", kind: "embedding" });
  value.config.model = "Xenova/all-MiniLM-L6-v2";
  const embedding = jest.spyOn(NativeEmbedder.prototype, "embedChunks");
  embedding.mockRejectedValueOnce({
    status: 429,
    message: "upstream echoed private-token",
  });
  await expect(runtime.embed(value, ["text"])).rejects.toMatchObject({
    status: 502,
    message: "模型服务限流或额度不足，请稍后重试",
  });
  const controller = new AbortController();
  const reason = new Error("canceled while provider was running");
  embedding.mockImplementationOnce(async () => {
    controller.abort(reason);
    return [[1, 2]];
  });
  await expect(
    runtime.embed(value, ["text"], { signal: controller.signal })
  ).rejects.toBe(reason);
});

test("unknown generation providers fail before invoking an SDK", async () => {
  await expect(
    runtime.complete(connection("invalid", { provider: "unknown" }), [])
  ).rejects.toMatchObject({ status: 400 });
});

test("prepared chat honors the selected provider/model and validates discovered context budgets", async () => {
  const selected = {
    model: "selected-model",
    promptWindowLimit: () => 2048,
    assertModelContextLimits: jest.fn(async () => {}),
  };
  const factory = jest
    .spyOn(require("../../utils/helpers"), "getLLMProvider")
    .mockReturnValue(selected);
  const prepared = await runtime.prepareChatConnection(connection(), {
    model: "override-model",
    temperature: 0.2,
    configuration: {
      chatProvider: "openai",
      chatModel: "configured-model",
      openAiTemp: 0.4,
    },
  });
  expect(factory).toHaveBeenCalledWith({
    provider: "openai",
    model: "override-model",
    temperature: 0.2,
  });
  expect(prepared).toMatchObject({
    contextWindow: 2048,
    config: { model: "selected-model" },
    resolvedProvider: selected,
  });
  expect(selected.assertModelContextLimits).toHaveBeenCalledTimes(1);
  selected.model = "";
  const fallback = await runtime.prepareChatConnection(connection(), {
    configuration: {
      chatProvider: "generic-openai",
      chatModel: "configured-model",
      openAiTemp: 0.4,
    },
  });
  expect(factory).toHaveBeenLastCalledWith({
    provider: "generic-openai",
    model: "configured-model",
    temperature: 0.4,
  });
  expect(fallback.config.model).toBe("known-model");
  for (const limit of [0, NaN]) {
    selected.promptWindowLimit = () => limit;
    await expect(
      runtime.prepareChatConnection(connection(), { model: "invalid-budget" })
    ).rejects.toMatchObject({
      status: 422,
      message: "模型上下文窗口无效，请核对原模型配置",
    });
  }
});

test.each([true, false])(
  "model routing resolves the current personal identity with explicit versus default configuration (%s)",
  async (explicit) => {
    const {
      AnythingLLMModelRouter,
    } = require("../../utils/AiProviders/modelRouter");
    const { ModelRouterService } = require("../../utils/router");
    const gathered = jest
      .spyOn(ModelRouterService, "gatherRoutingContext")
      .mockResolvedValue({
        conversationTokenCount: 12,
        conversationMessageCount: 3,
      });
    const resolved = jest
      .spyOn(AnythingLLMModelRouter.prototype, "resolve")
      .mockImplementation(async function () {
        this.delegateProvider = {
          model: "routed-model",
          promptWindowLimit: () => 3072,
        };
      });
    const ctx = {
      identity: "tenant",
      tenantId: "company-a",
      userId: "employee-a",
      user: { id: "employee-a" },
    };
    const thread = { id: "personal-thread" };
    const options = {
      ctx,
      thread,
      ...(explicit
        ? {
            prompt: "Route my request",
            attachments: [{ name: "attachment" }],
            configuration: { chatProvider: "anythingllm-router", router_id: 7 },
          }
        : {}),
    };
    const value = connection("routing", {
      provider: explicit ? "openai-compatible" : "anythingllm-router",
    });
    const prepared = await runtime.prepareChatConnection(value, options);
    expect(prepared.contextWindow).toBe(3072);
    expect(gathered).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx,
        thread,
        message: explicit ? "Route my request" : "",
      })
    );
    expect(resolved).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationTokenCount: 12,
        conversationMessageCount: 3,
        attachments: explicit ? [{ name: "attachment" }] : [],
      }),
      { ctx, user: ctx.user, thread }
    );
  }
);

test("compression delegates to the original provider and preserves personal history inputs", async () => {
  const compressed = { systemPrompt: "Compressed", chatHistory: [] };
  const spy = jest
    .spyOn(GenericOpenAiLLM.prototype, "compressMessages")
    .mockResolvedValue(compressed);
  await expect(
    runtime.compress(connection(), { systemPrompt: "Personal prompt" })
  ).resolves.toBe(compressed);
  expect(spy).toHaveBeenCalledWith(
    expect.objectContaining({
      systemPrompt: "Personal prompt",
      chatHistory: [],
    }),
    []
  );
});

test("a stream error event is sanitized before any token or event callback can publish data", async () => {
  jest
    .spyOn(GenericOpenAiLLM.prototype, "streamGetChatCompletion")
    .mockResolvedValue({});
  jest
    .spyOn(GenericOpenAiLLM.prototype, "handleStream")
    .mockImplementation(async (response) => {
      expect(response.write(": keepalive\n")).toBe(true);
      response.write('data: {"error":"upstream private-test-token"}\n');
      return "";
    });
  const token = jest.fn(),
    event = jest.fn();
  await expect(
    runtime.complete(connection(), [], token, { onEvent: event })
  ).rejects.toMatchObject({
    status: 502,
    message: "模型服务在生成过程中返回错误",
  });
  expect(token).not.toHaveBeenCalled();
  expect(event).not.toHaveBeenCalled();
});

test("non-text stream events remain observable but never become answer tokens", async () => {
  jest
    .spyOn(GenericOpenAiLLM.prototype, "streamGetChatCompletion")
    .mockResolvedValue({});
  jest
    .spyOn(GenericOpenAiLLM.prototype, "handleStream")
    .mockImplementation(async (response) => {
      response.write('data: {"type":"usageMetrics","textResponse":""}\n');
      response.write('data: {"textResponse":17}\n');
      return "";
    });
  const token = jest.fn(),
    event = jest.fn();
  await expect(
    runtime.complete(connection(), [], token, { onEvent: event })
  ).resolves.toBe("");
  expect(event).toHaveBeenCalledTimes(2);
  expect(token).not.toHaveBeenCalled();
});

test("destroyed streams ignore late writes and malformed SSE cannot expose its raw payload", async () => {
  jest
    .spyOn(GenericOpenAiLLM.prototype, "streamGetChatCompletion")
    .mockResolvedValue({});
  const decode = jest.spyOn(GenericOpenAiLLM.prototype, "handleStream");
  decode.mockImplementationOnce(async (response) => {
    response.destroyed = true;
    expect(response.write('data: {"textResponse":"late"}\n')).toBe(false);
    return "";
  });
  const token = jest.fn();
  await expect(runtime.complete(connection(), [], token)).resolves.toBe("");
  expect(token).not.toHaveBeenCalled();
  decode.mockImplementationOnce(async (response) => {
    response.write("data: private-test-token is invalid JSON\n");
  });
  await expect(runtime.complete(connection(), [], token)).rejects.toMatchObject(
    { status: 502, message: expect.not.stringContaining("private-test-token") }
  );
});
