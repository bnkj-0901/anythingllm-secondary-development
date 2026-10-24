const {
  packPrompt,
  countTokens,
  prepareChatContext,
} = require("../../enterprise/prompt-context");
const providers = require("../../enterprise/providers");
const { TokenManager } = require("../../utils/helpers/tiktoken");
const { compressChatMessages } = require("../../utils/chats/stream");
const { runConnection } = require("../../enterprise/ai/connection-context");
const connection = (contextWindow = 16384) => ({
  provider: "openai-compatible",
  config: {
    model: "test-chat",
    baseUrl: "http://127.0.0.1:1/v1",
    apiKey: "unused",
    options: { contextWindow, maxTokens: 1000 },
  },
});
const candidate = (text, extra = {}) => ({
  id: "c1",
  documentId: "d1",
  title: "Authorized document",
  score: 1,
  text,
  ...extra,
});
const pair = (prompt, text, sources = [], extra = {}) => ({
  prompt,
  response: JSON.stringify({ text, sources }),
  include: true,
  ...extra,
});

async function upstreamPrompt(c, args, history = []) {
  return runConnection(c, {}, () => {
    const {
      GenericOpenAiLLM,
    } = require("../../utils/AiProviders/genericOpenAi");
    return compressChatMessages(
      new GenericOpenAiLLM({}, c.config.model),
      args,
      history
    );
  });
}

test("personal context uses the original provider's prompt construction and compressor", async () => {
  const history = [pair("Previous question", "Previous answer")];
  const sources = [candidate("Friday submission")];
  const packed = await packPrompt(connection(), "When?", history, sources, {
    systemPrompt: "Use company format.",
  });
  const expected = await upstreamPrompt(
    connection(),
    {
      systemPrompt: "Use company format.",
      userPrompt: "When?",
      contextTexts: ["Friday submission"],
      attachments: [],
    },
    history
  );
  expect(packed.messages).toEqual(expected);
  expect(packed.messages[0].content).toContain(
    "[CONTEXT 0]:\nFriday submission"
  );
  expect(packed.sources).toEqual(sources);
  expect(packed.historySources).toEqual([]);
});

test("default prompt stays the upstream prompt with no added persona", async () => {
  const packed = await packPrompt(connection(), "Hello", [], []);
  expect(packed.messages[0].content).toBe(
    require("../../models/systemSettings").SystemSettings
      .saneDefaultSystemPrompt
  );
});

test("temporary documents and upstream citation backfill remain context, while current citations stay current", async () => {
  const old = candidate("Historical snapshot", { id: "old" });
  const sources = [candidate("Current result")];
  const history = [pair("Previous question", "Saved answer", [old])];
  const before = JSON.stringify({ history, sources });
  const contexts = prepareChatContext(history, sources, {
    documents: [{ pageContent: "Temporary document" }],
    topK: 4,
  });
  expect(contexts.contextTexts).toEqual([
    "Temporary document",
    "Current result",
    "Historical snapshot",
  ]);
  const packed = await packPrompt(connection(), "Follow up", history, sources, {
    documents: [{ pageContent: "Temporary document" }],
  });
  expect(packed.messages[0].content).toContain("Historical snapshot");
  expect(packed.messages[0].content).toContain("Temporary document");
  expect(packed.sources).toEqual(sources);
  expect(JSON.stringify({ history, sources })).toBe(before);
});

test("oversized context and history use the provider's own compression policy", async () => {
  const c = connection(5000),
    history = [pair("Old question ".repeat(1000), "Old answer ".repeat(1000))];
  const sources = [candidate("Context ".repeat(6000))];
  const packed = await packPrompt(c, "Current question", history, sources, {
    systemPrompt: "Company prompt",
  });
  const expected = await upstreamPrompt(
    c,
    {
      systemPrompt: "Company prompt",
      userPrompt: "Current question",
      contextTexts: [sources[0].text],
      attachments: [],
    },
    history
  );
  expect(packed.messages).toEqual(expected);
  expect(JSON.stringify(packed.messages)).toContain(
    "prompt truncated for brevity"
  );
});

test("vision encoding remains provider-specific", async () => {
  const image = {
    name: "image.png",
    mime: "image/png",
    contentString: "data:image/png;base64,aGVsbG8=",
  };
  const packed = await packPrompt(connection(), "Describe", [], [], {
    attachments: [image],
  });
  expect(packed.messages.at(-1).content).toEqual(
    expect.arrayContaining([expect.objectContaining({ type: "image_url" })])
  );
});

test("non-array provider prompts are passed through without OpenAI reconstruction", async () => {
  const compressed = jest
    .spyOn(providers, "compress")
    .mockResolvedValue("provider-specific prompt");
  try {
    expect((await packPrompt(connection(), "Question", [], [])).messages).toBe(
      "provider-specific prompt"
    );
  } finally {
    compressed.mockRestore();
  }
});

test("reset and incomplete pairs do not enter model history", async () => {
  const packed = await packPrompt(
    connection(),
    "Current",
    [
      pair("orphan", ""),
      pair("reset question", "reset answer", [], { include: false }),
      pair("valid question", "valid answer"),
    ],
    []
  );
  expect(JSON.stringify(packed.messages)).toContain("valid answer");
  expect(JSON.stringify(packed.messages)).not.toContain("orphan");
  expect(JSON.stringify(packed.messages)).not.toContain("reset question");
});

test("token statistics retain the upstream tokenizer and unknown-model fallback", () => {
  const messages = [{ role: "user", content: "中英文 🌱 examples" }];
  for (const model of ["gpt-4", "unknown-tenant-model"])
    expect(countTokens({ config: { model } }, messages)).toBe(
      new TokenManager(model).statsFrom(messages)
    );
});

test.each([
  () => {
    throw new Error("private-tokenizer-error");
  },
  () => 0,
])(
  "tokenizer failure rejects without leaking input",
  async (implementation) => {
    const count = jest
      .spyOn(TokenManager.prototype, "countFromString")
      .mockImplementation(implementation);
    try {
      await expect(
        packPrompt(connection(), "Private question", [], [])
      ).rejects.toMatchObject({
        status: 503,
        message: "模型 Token 计算失败，请稍后重试",
      });
    } finally {
      count.mockRestore();
    }
  }
);
