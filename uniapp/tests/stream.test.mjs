import test from "node:test";
import assert from "node:assert/strict";
import {
  createAnswerStream,
  createUtf8Decoder,
} from "../src/services/enterprise-stream.mjs";
import {
  createEnterpriseClient,
  TOKEN_KEY,
  SESSION_KEY,
} from "../src/services/enterprise.mjs";

const endpoint = "https://acme.example.com/api";
const identity = {
  identity: "tenant",
  user: { id: "u1", username: "alice", name: "Alice" },
  tenant: { id: "t1", code: "acme", name: "Acme" },
  role: "user",
  token: "token",
  endpoint,
};
const answer = {
  id: "m1",
  role: "assistant",
  content: "中文😀答案",
  sources: [],
};
const event = (value, newline = "\n") =>
  `data: ${JSON.stringify(value)}${newline}${newline}`;
const wire =
  event({ type: "start" }, "\r\n") +
  event({ type: "textResponseChunk", textResponse: "中文😀" }, "\r\n") +
  event({ type: "finalizeResponseStream", message: answer }, "\r\n");
const persistedAnswer = {
  ...answer,
  id: 42,
  sources: [{ id: "chunk-1", title: "安装说明", text: "来源内容" }],
};
const persistedWire =
  event({ type: "textResponseChunk", textResponse: "中文😀答案" }) +
  event({
    id: "response-uuid",
    type: "finalizeResponseStream",
    chatId: persistedAnswer.id,
    message: persistedAnswer,
    close: true,
    error: false,
  });

function harness() {
  const storage = new Map([
    [TOKEN_KEY, "token"],
    [SESSION_KEY, identity],
  ]);
  const requests = [];
  const aborted = [];
  const runtime = {
    getStorageSync: (key) => storage.get(key),
    setStorageSync: (key, value) => storage.set(key, value),
    removeStorageSync: (key) => storage.delete(key),
    request(options) {
      const record = { options, chunk: null, headers: null };
      requests.push(record);
      return {
        abort() {
          aborted.push(record);
        },
        onChunkReceived(handler) {
          record.chunk = handler;
        },
        onHeadersReceived(handler) {
          record.headers = handler;
        },
      };
    },
  };
  return {
    runtime,
    requests,
    aborted,
    storage,
    client: (options) => createEnterpriseClient({ runtime, baseURL: endpoint, ...options }),
  };
}
function bytes(value) {
  return new Uint8Array(Buffer.from(value));
}
function chunk(record, value) {
  record.chunk({
    data: typeof value === "string" ? bytes(value).buffer : value,
  });
}
function done(record) {
  record.options.success({ statusCode: 200, data: new ArrayBuffer(0) });
}

test("UTF-8 decoder works without TextDecoder and preserves every multi-byte split", () => {
  const saved = globalThis.TextDecoder;
  globalThis.TextDecoder = undefined;
  try {
    const value = "知识😀𠮷 é，末尾";
    const encoded = bytes(value);
    for (let split = 0; split <= encoded.length; split++) {
      const decode = createUtf8Decoder();
      assert.equal(
        decode(encoded.slice(0, split)) + decode(encoded.slice(split), true),
        value
      );
    }
  } finally {
    globalThis.TextDecoder = saved;
  }
});

test("SSE parser handles CRLF split at every byte and emits final only at finish", () => {
  const encoded = bytes(wire);
  const events = [];
  const parse = createAnswerStream((value) => events.push(value));
  const decode = createUtf8Decoder();
  for (const byte of encoded) parse.append(decode(new Uint8Array([byte])));
  assert.deepEqual(
    events.map((value) => value.type),
    ["start", "delta"]
  );
  parse.append(decode(null, true));
  assert.deepEqual(parse.finish(), { message: answer });
  assert.deepEqual(events.at(-1), { type: "done", message: answer });
});

test("SSE parser rejects absent final, malformed final, provider errors and data after final", () => {
  const missing = createAnswerStream(() => {});
  missing.append(event({ type: "textResponseChunk", textResponse: "临时内容" }));
  assert.throws(() => missing.finish(), /连接中断/);
  for (const message of [
    {},
    { id: "m", role: "user", content: "a" },
    { ...answer, content: "" },
    { ...answer, sources: {} },
  ])
    assert.throws(
      () =>
        createAnswerStream(() => {}).append(event({ type: "finalizeResponseStream", message })),
      /最终回答/
    );
  assert.throws(
    () =>
      createAnswerStream(() => {}).append(
        event({ type: "error", error: "资料已删除" })
      ),
    /资料已删除/
  );
  const extra = createAnswerStream(() => {});
  assert.throws(
    () =>
      extra.append(
        event({ type: "finalizeResponseStream", message: answer }) +
          event({ type: "textResponseChunk", textResponse: "多余" })
      ),
    /额外数据/
  );
});

test("SSE final responses preserve original numeric chat IDs and sources", () => {
  for (const final of [
    { message: persistedAnswer, chatId: persistedAnswer.id },
    {
      chatId: persistedAnswer.id,
      textResponse: persistedAnswer.content,
      sources: persistedAnswer.sources,
    },
  ]) {
    const parse = createAnswerStream(() => {});
    parse.append(event({ type: "finalizeResponseStream", ...final }));
    assert.deepEqual(parse.finish(), { message: persistedAnswer });
  }
});

test("SSE final responses reject invalid persisted chat IDs", () => {
  for (const id of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, null, {}, [], true]) {
    assert.throws(
      () => createAnswerStream(() => {}).append(event({
        type: "finalizeResponseStream",
        message: { ...answer, id },
      })),
      /最终回答/
    );
  }
});

test("ephemeral command answers use the event UUID without requiring a saved chat id", () => {
  const message = {
    role: "assistant",
    content: "Conversation history has been reset.",
    sources: [],
    ephemeral: true,
  };
  const events = [];
  const parse = createAnswerStream((value) => events.push(value));
  parse.append(event({
    id: "command-event-1",
    type: "finalizeResponseStream",
    close: true,
    error: false,
    message,
  }));
  assert.deepEqual(parse.finish(), {
    message: { ...message, id: "command-event-1" },
  });
  assert.equal(events.at(-1).message.ephemeral, true);
  assert.equal(message.id, undefined);
  assert.throws(
    () => createAnswerStream(() => {}).append(event({
      id: "command-event-2",
      type: "finalizeResponseStream",
      message: { ...message, ephemeral: false },
    })),
    /最终回答/
  );
});

test("WeChat accepts image generation progress before the saved final response", async () => {
  const h = harness();
  const events = [];
  const result = h.client().streamMessage("c1", "/img a forest", (value) => events.push(value));
  const pending = {
    id: "image-event-1",
    type: "imageGenerationPending",
    close: false,
    error: false,
  };
  const generated = {
    ...answer,
    content: "![Generated image](/api/generated-images/forest.png)",
    outputs: [{ type: "image", filename: "forest.png" }],
  };
  chunk(h.requests[0], event(pending) + event({
    id: "image-event-1",
    type: "finalizeResponseStream",
    message: generated,
    close: true,
    error: false,
  }));
  done(h.requests[0]);
  assert.deepEqual(await result, { message: generated });
  assert.deepEqual(events[0], pending);
  assert.deepEqual(events.at(-1), { type: "done", message: generated });
});

test("WeChat uses chunked authenticated SSE and commits only the final message", async () => {
  const h = harness();
  const events = [];
  const result = h
    .client()
    .streamMessage("c /1", "问题", (value) => events.push(value));
  const record = h.requests[0];
  assert.equal(
    record.options.url,
    endpoint + "/enterprise/conversations/c%20%2F1/messages"
  );
  assert.deepEqual(record.options.data, { message: "问题", stream: true });
  assert.equal(record.options.enableChunked, true);
  assert.equal(record.options.responseType, "arraybuffer");
  assert.equal(record.options.header.Authorization, "Bearer token");
  record.headers({ statusCode: 200 });
  const encoded = bytes(persistedWire);
  for (let offset = 0; offset < encoded.length; offset += 2)
    chunk(record, encoded.slice(offset, offset + 2));
  assert.equal(
    events.some((value) => value.type === "done"),
    false
  );
  done(record);
  assert.deepEqual(await result, { message: persistedAnswer });
  assert.equal(events.at(-1).type, "done");
});

test("stopping one message aborts only its request and ignores its late final", async () => {
  const h = harness();
  const client = h.client();
  const management = client.libraries();
  const events = [];
  const result = client.streamMessage("c1", "问题", (value) =>
    events.push(value)
  );
  chunk(h.requests[1], event({ type: "textResponseChunk", textResponse: "撤回的预览" }));
  result.cancel();
  await assert.rejects(result, (error) => error.cancelled === true);
  chunk(h.requests[1], event({ type: "finalizeResponseStream", message: answer }));
  done(h.requests[1]);
  assert.equal(
    events.some((value) => value.type === "done"),
    false
  );
  assert.deepEqual(h.aborted, [h.requests[1]]);
  h.requests[0].options.success({ statusCode: 200, data: { libraries: [] } });
  assert.deepEqual(await management, { libraries: [] });
});

test("logging out invalidates a stream immediately, including queued final callbacks", async () => {
  const h = harness();
  const client = h.client();
  const events = [];
  const result = client.streamMessage("c1", "问题", (value) =>
    events.push(value)
  );
  chunk(h.requests[0], event({ type: "textResponseChunk", textResponse: "旧企业" }));
  client.clearSession();
  await assert.rejects(result, (error) => error.status === 409);
  chunk(h.requests[0], event({ type: "finalizeResponseStream", message: answer }));
  done(h.requests[0]);
  assert.equal(
    events.some((value) => value.type === "done"),
    false
  );
  assert.equal(client.hasToken(), false);
});

test("stream errors, HTTP 401 and truncated streams cannot publish final answers", async () => {
  for (const mode of ["event", "truncated", "401"]) {
    const h = harness();
    const events = [];
    let unauthorized = 0;
    const client = h.client({
      onUnauthorized() {
        unauthorized++;
      },
    });
    const result = client.streamMessage("c1", "问题", (value) =>
      events.push(value)
    );
    const record = h.requests[0];
    if (mode === "401") {
      record.headers({ statusCode: 401 });
      chunk(record, JSON.stringify({ error: "登录已过期" }));
      record.options.success({ statusCode: 401, data: new ArrayBuffer(0) });
    } else {
      chunk(record, event({ type: "textResponseChunk", textResponse: "尚未校验" }));
      if (mode === "event")
        chunk(record, event({ type: "error", error: "来源已失效" }));
      done(record);
    }
    await assert.rejects(result);
    assert.equal(
      events.some((value) => value.type === "done"),
      false
    );
    if (mode === "401") {
      assert.equal(unauthorized, 1);
      assert.equal(client.hasToken(), false);
    }
  }
});

test("H5 fetch reads actual chunks and returns the same final event contract", async () => {
  const h = harness();
  let request;
  let index = 0;
  let cancelled = false;
  const encoded = bytes(persistedWire);
  const events = [];
  const client = h.client({
    fetch: async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        headers: { get: () => "text/event-stream; charset=utf-8" },
        body: {
          getReader: () => ({
            async read() {
              if (index === encoded.length) return { done: true };
              return { done: false, value: encoded.slice(index, ++index) };
            },
            async cancel() {
              cancelled = true;
            },
            releaseLock() {},
          }),
        },
      };
    },
  });
  const result = await client.streamMessage("c1", "问题", (value) =>
    events.push(value)
  );
  assert.equal(request.url, endpoint + "/enterprise/conversations/c1/messages");
  assert.deepEqual(JSON.parse(request.options.body), {
    message: "问题",
    stream: true,
  });
  assert.deepEqual(result, { message: persistedAnswer });
  assert.equal(events.at(-1).type, "done");
  assert.equal(cancelled, true);
});

test("H5 stop aborts its fetch and HTTP 401 clears the enterprise session", async () => {
  const h = harness();
  let signal;
  const client = h.client({
    fetch: (_url, options) => {
      signal = options.signal;
      return new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(new Error("aborted")))
      );
    },
  });
  const stopped = client.streamMessage("c1", "问题");
  stopped.cancel();
  await assert.rejects(stopped, (error) => error.cancelled);
  assert.equal(signal.aborted, true);
  let unauthorized = 0;
  const expired = h.client({
    fetch: async () => ({
      ok: false,
      status: 401,
      json: async () => ({ error: "登录已过期" }),
    }),
    onUnauthorized() {
      unauthorized++;
    },
  });
  await assert.rejects(
    expired.streamMessage("c1", "问题"),
    (error) => error.status === 401
  );
  assert.equal(unauthorized, 1);
  assert.equal(expired.hasToken(), false);
});

test("file formats are requested from the current enterprise API without a client preset", async () => {
  const h = harness();
  const result = h.client().fileTypes();
  assert.equal(h.requests[0].options.url, endpoint + "/enterprise/file-types");
  const formats = { extensions: [".xlsx", ".odt"], maxFileSizeBytes: 1048576 };
  h.requests[0].options.success({ statusCode: 200, data: formats });
  assert.deepEqual(await result, formats);
});
