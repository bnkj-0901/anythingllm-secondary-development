/* global jest, beforeAll, afterAll, beforeEach, test, expect */
const http = require("http");
const { once } = require("events");
const runtime = require("../../enterprise/ai/runtime");
const {
  env,
  runWithEnvironment,
  runConnection,
  scopedCacheFolder,
} = require("../../enterprise/ai/connection-context");
const { NativeEmbedder } = require("../../utils/EmbeddingEngines/native");

const requests = [];
let server, baseUrl;
const connection = (id, kind = "chat", overrides = {}) => ({
  id,
  version: 1,
  kind,
  provider: "openai-compatible",
  config: {
    model: `model-${id}`,
    baseUrl: `${baseUrl}/${id}/v1`,
    apiKey: `fixture-${id}`,
    headers: { "x-tenant-fixture": id },
    options: { contextWindow: 4096, maxTokens: 128 },
    ...overrides,
  },
});

// Intercept only the test transport; production fixed providers retain their
// original URL instead of gaining a custom-endpoint product capability.
async function withOriginalEndpoint(endpoint, action) {
  // The SDK accepts a custom fetch without changing the provider implementation.
  const originalFetch = global.fetch;
  global.fetch = (input, init) => {
    const target = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url
    );
    const prefix = "/v1";
    return originalFetch(
      endpoint + target.pathname.slice(prefix.length) + target.search,
      init
    );
  };
  try {
    return await action();
  } finally {
    global.fetch = originalFetch;
  }
}

beforeAll(async () => {
  server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null;
    requests.push({ url: req.url, headers: req.headers, body });
    const id = req.url.split("/")[1];
    if (id === "error") {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "fixture rejects secret" } }));
      return;
    }
    if (req.url.endsWith("/models")) {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          data: [
            {
              id: id === "deepseek" ? "deepseek-chat" : `model-${id}`,
              owned_by: "fixture",
            },
          ],
        })
      );
      return;
    }
    if (req.url.endsWith("/embeddings")) {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          data: body.input.map((_, index) => ({
            index,
            embedding: Buffer.from(
              new Float32Array([index + 1, 2]).buffer
            ).toString("base64"),
          })),
        })
      );
      return;
    }
    if (req.url.endsWith("/responses")) {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          output_text: `response-${id}`,
          usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
        })
      );
      return;
    }
    if (!body.stream) {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: `answer-${id}`,
                reasoning_content: `reason-${id}`,
              },
            },
          ],
          usage: { prompt_tokens: 4, completion_tokens: 2 },
        })
      );
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const event = (value) => res.write(`data: ${JSON.stringify(value)}\n\n`);
    event({ choices: [{ delta: { reasoning_content: `reason-${id}` } }] });
    if (id === "cancel") {
      const timer = setTimeout(() => res.end(), 2000);
      res.on("close", () => clearTimeout(timer));
      return;
    }
    if (id === "stream-error") {
      event({ error: { message: "fixture stream failure" } });
      res.end();
      return;
    }
    event({ choices: [{ delta: { content: `answer-${id}` } }] });
    event({
      choices: [{ delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 4, completion_tokens: 2 },
    });
    res.end("data: [DONE]\n\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => requests.splice(0));

test("parallel tenants use their own original chat SDK credentials and URL", async () => {
  const metrics = [];
  const results = await Promise.all(
    ["a", "b"].map((id) =>
      runtime.complete(
        connection(id),
        [{ role: "user", content: "hello" }],
        null,
        { onMetrics: (value) => metrics.push(value) }
      )
    )
  );
  expect(results).toEqual([
    "<think>reason-a</think>answer-a",
    "<think>reason-b</think>answer-b",
  ]);
  expect(metrics).toHaveLength(2);
  expect(metrics[0].prompt_tokens).toBe(4);
  for (const request of requests) {
    const id = request.url.split("/")[1];
    expect(request.headers.authorization).toBe(`Bearer fixture-${id}`);
    expect(request.headers["x-tenant-fixture"]).toBe(id);
    expect(request.body.model).toBe(`model-${id}`);
    expect(request.body.max_tokens).toBe(128);
  }
});

test("tenant scope cannot fall back to platform environment credentials", async () => {
  const original = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = "fixture-global";
  try {
    await runWithEnvironment({}, async () => {
      await Promise.resolve();
      expect(env.DEEPSEEK_API_KEY).toBeUndefined();
      env.DEEPSEEK_API_KEY = "fixture-local";
      expect(env.DEEPSEEK_API_KEY).toBe("fixture-local");
      expect(process.env.DEEPSEEK_API_KEY).toBe("fixture-global");
    });
    expect(env.DEEPSEEK_API_KEY).toBe("fixture-global");
  } finally {
    if (original === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = original;
  }
});

test("original SSE decoder keeps reasoning text and provider metrics", async () => {
  const tokens = [],
    metrics = [];
  const text = await runtime.complete(
    connection("stream"),
    [{ role: "user", content: "hello" }],
    (token) => tokens.push(token),
    { onMetrics: (value) => metrics.push(value) }
  );
  expect(text).toBe("<think>reason-stream</think>answer-stream");
  expect(tokens.join("")).toBe(text);
  expect(metrics[0]).toMatchObject({ completion_tokens: 2, prompt_tokens: 4 });
});

test("OpenAI retains its original Responses API protocol for tenant endpoints", async () => {
  const openai = connection("openai");
  openai.provider = "openai";
  openai.config.model = "gpt-4.1-mini";
  const result = await withOriginalEndpoint(`${baseUrl}/openai/v1`, () =>
    runtime.complete(openai, [{ role: "user", content: "hello" }])
  );
  expect(result).toBe("response-openai");
  expect(requests[0].url).toBe("/openai/v1/responses");
  expect(requests[0].body).toMatchObject({
    model: "gpt-4.1-mini",
    input: [{ role: "user", content: "hello" }],
    store: false,
  });
});

test("DeepSeek uses its original provider and scoped chat-completion connection", async () => {
  const deepseek = connection("deepseek");
  deepseek.provider = "deepseek";
  deepseek.config.model = "deepseek-chat";
  const result = await withOriginalEndpoint(`${baseUrl}/deepseek/v1`, () =>
    runtime.complete(deepseek, [{ role: "user", content: "hello" }])
  );
  expect(result).toContain("answer-deepseek");
  const completion = requests.find((request) =>
    request.url.endsWith("/chat/completions")
  );
  expect(completion.headers.authorization).toBe("Bearer fixture-deepseek");
  expect(completion.body.model).toBe("deepseek-chat");
});

test("original provider context-window caches are isolated while running tenants", async () => {
  const { OllamaAILLM } = require("../../utils/AiProviders/ollama");
  const original = OllamaAILLM.modelContextWindows;
  try {
    OllamaAILLM.modelContextWindows = {};
    const values = await Promise.all(
      ["a", "b"].map((id) =>
        runConnection(connection(id), {}, async () => {
          OllamaAILLM.modelContextWindows.model = id;
          await Promise.resolve();
          return OllamaAILLM.modelContextWindows.model;
        })
      )
    );
    expect(values).toEqual(["a", "b"]);
    expect(OllamaAILLM.modelContextWindows).toEqual({});
  } finally {
    OllamaAILLM.modelContextWindows = original;
  }
});

test("model caches are reused by the same connection and refreshed after its credentials change", async () => {
  const { OllamaAILLM } = require("../../utils/AiProviders/ollama");
  const source = connection("reused-cache");
  await runConnection(source, {}, () => {
    OllamaAILLM.modelContextWindows.model = 8192;
  });
  expect(
    await runConnection(
      connection("reused-cache"),
      {},
      () => OllamaAILLM.modelContextWindows.model
    )
  ).toBe(8192);
  expect(
    await runConnection(
      connection("reused-cache", "chat", { apiKey: "rotated" }),
      {},
      () => OllamaAILLM.modelContextWindows.model
    )
  ).toBeUndefined();
});

test("reasoning-summary refusal is restricted to its original tenant call", async () => {
  const {
    createWithReasoningSummaryFallback,
    resetReasoningSummaryFallback,
  } = require("../../utils/helpers/reasoningEffort");
  resetReasoningSummaryFallback();
  const payload = {
    model: "gpt-fixture",
    reasoning: { summary: "auto", effort: "low" },
  };
  const a = jest
    .fn()
    .mockRejectedValueOnce(
      Object.assign(
        new Error("organization verification required for summary"),
        { status: 400 }
      )
    )
    .mockResolvedValue("a");
  const b = jest.fn().mockResolvedValue("b");
  await runConnection(connection("a"), {}, async () => {
    await createWithReasoningSummaryFallback(a, payload);
    await createWithReasoningSummaryFallback(a, payload);
  });
  await runConnection(connection("b"), {}, () =>
    createWithReasoningSummaryFallback(b, payload)
  );
  expect(a.mock.calls[2][0].reasoning.summary).toBeUndefined();
  expect(b.mock.calls[0][0].reasoning.summary).toBe("auto");
});

test("cancelling a tenant stream stops the original upstream request", async () => {
  const controller = new AbortController();
  const reason = new Error("fixture cancelled");
  await expect(
    runtime.complete(
      connection("cancel"),
      [{ role: "user", content: "hello" }],
      () => controller.abort(reason),
      { signal: controller.signal }
    )
  ).rejects.toBe(reason);
});

test("an asynchronous permission guard terminates the original SDK stream and remains a permission error", async () => {
  const guard = Object.assign(new Error("source access revoked"), {
    status: 403,
    enterpriseGuard: true,
  });
  await expect(
    runtime.complete(
      connection("cancel"),
      [{ role: "user", content: "hello" }],
      async () => {
        await new Promise((resolve) => setImmediate(resolve));
        throw guard;
      }
    )
  ).rejects.toBe(guard);
});

test("provider rejection returns a safe connection error", async () => {
  await expect(
    runtime.complete(connection("error"), [{ role: "user", content: "hello" }])
  ).rejects.toMatchObject({ status: 502 });
});

test("original SSE errors are not saved as successful partial answers", async () => {
  await expect(
    runtime.complete(
      connection("stream-error"),
      [{ role: "user", content: "hello" }],
      () => {}
    )
  ).rejects.toMatchObject({ status: 502 });
});

test("embedding uses original SDK, batching and prefix behavior inside scope", async () => {
  const first = connection("embed-a", "embedding");
  first.config.options = {
    batchSize: 1,
    queryPrefix: "query: ",
    documentPrefix: "document: ",
  };
  const second = connection("embed-b", "embedding");
  const results = await Promise.all([
    runtime.embed(first, ["one", "two"], { query: true }),
    runtime.embed(second, ["three"]),
  ]);
  expect(results).toEqual([
    [
      [1, 2],
      [1, 2],
    ],
    [[1, 2]],
  ]);
  const a = requests.filter((request) => request.url.startsWith("/embed-a/"));
  expect(a.map((request) => request.body.input)).toEqual([
    ["query: one"],
    ["query: two"],
  ]);
  expect(
    requests.find((request) => request.url.startsWith("/embed-b/")).headers
      .authorization
  ).toBe("Bearer fixture-embed-b");
});

test("prepared chat budgets exactly match original provider defaults and configured limits", async () => {
  let generic = connection("budget");
  delete generic.config.options.contextWindow;
  const prepared = await runtime.prepareChatConnection(generic);
  expect(prepared.contextWindow).toBe(4096);
  generic = connection("configured-budget");
  generic.config.options.contextWindow = 8192;
  expect((await runtime.prepareChatConnection(generic)).contextWindow).toBe(
    8192
  );
  expect(requests).toHaveLength(0);
});

test("connection caches never share a path across tenant credentials", async () => {
  const paths = await Promise.all(
    ["a", "b"].map((id) =>
      runConnection(connection(id), {}, async () => {
        await Promise.resolve();
        return scopedCacheFolder("fixture-cache");
      })
    )
  );
  expect(paths[0]).not.toBe(paths[1]);
  expect(scopedCacheFolder("fixture-cache")).toBe("fixture-cache");
});

test("native embedder selects the connection model through its original constructor", async () => {
  const spy = jest
    .spyOn(NativeEmbedder.prototype, "embedChunks")
    .mockImplementation(async function (texts) {
      expect(this.model).toBe("Xenova/all-MiniLM-L6-v2");
      return texts.map(() => [1, 2]);
    });
  try {
    const native = connection("native", "embedding");
    native.provider = "native";
    native.config.model = "Xenova/all-MiniLM-L6-v2";
    expect(await runtime.embed(native, ["hello"])).toEqual([[1, 2]]);
  } finally {
    spy.mockRestore();
  }
});

test("knowledge chunks follow the original embedder's own instance limit", () => {
  const { embeddingChunkLimit } = require("../../enterprise/ai/options");
  const generic = connection("chunk", "embedding");
  expect(embeddingChunkLimit(generic)).toBe(1000);
  const azure = connection("azure", "embedding");
  azure.provider = "azure";
  azure.config.options.maxChunkLength = 9999;
  expect(embeddingChunkLimit(azure)).toBe(2048);
  const cohere = connection("cohere", "embedding");
  cohere.provider = "cohere";
  expect(embeddingChunkLimit(cohere)).toBe(1945);
  const voyage = connection("voyage", "embedding");
  voyage.provider = "voyage";
  voyage.config.model = "voyage-3-lite";
  expect(embeddingChunkLimit(voyage)).toBe(32000);
});

test("stored aliases resolve through the original factories for every supported provider", () => {
  const { providerClass } = require("../../enterprise/ai/provider-config");
  const {
    getLLMProviderClass,
    getEmbeddingEngineClass,
  } = require("../../utils/helpers");
  // Read the upstream selectors rather than copying another supported-provider list.
  for (const [kind, factory] of [
    ["chat", getLLMProviderClass],
    ["embedding", getEmbeddingEngineClass],
  ]) {
    const names = [...factory.toString().matchAll(/case "([^"]+)"/g)].map(
      (match) => match[1]
    );
    expect(names.length).toBeGreaterThan(10);
    for (const provider of names) {
      const expected =
        kind === "chat" ? factory({ provider }) : factory(provider);
      expect(providerClass(provider, kind)).toBe(expected);
    }
  }
  expect(providerClass("openai-compatible", "chat")).toBe(
    getLLMProviderClass({ provider: "generic-openai" })
  );
  expect(providerClass("openai-compatible", "embedding")).toBe(
    getEmbeddingEngineClass("generic-openai")
  );
  expect(providerClass("voyage", "embedding")).toBe(
    getEmbeddingEngineClass("voyageai")
  );
  expect(providerClass("unknown", "embedding")).toBeNull();
});

test("the original embedding instance factory reads the current request without crossing tenant configuration", async () => {
  const { getEmbeddingEngineSelection } = require("../../utils/helpers");
  const result = await Promise.all(
    ["factory-a", "factory-b"].map((id) =>
      runConnection(connection(id, "embedding"), {}, async () => {
        await new Promise((resolve) => setImmediate(resolve));
        const embedder = getEmbeddingEngineSelection();
        return [embedder.model, embedder.basePath];
      })
    )
  );
  expect(result).toEqual([
    ["model-factory-a", `${baseUrl}/factory-a/v1`],
    ["model-factory-b", `${baseUrl}/factory-b/v1`],
  ]);
});
