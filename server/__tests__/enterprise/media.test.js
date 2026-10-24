const express = require("express");
const http = require("http");
const jwt = require("jsonwebtoken");
const { createPostgresFixture } = require("./postgres-fixture.cjs");

let mockFixture;
const mockSpeech = jest.fn();
const mockTranscription = jest.fn();
const mockStore = Object.fromEntries(
  ["all", "one", "run", "transaction", "id", "now"].map((key) => [
    key,
    (...args) => mockFixture.db[key](...args),
  ])
);
Object.defineProperty(mockStore, "orm", { get: () => mockFixture.db.orm });
jest.mock("../../enterprise/store", () => mockStore);
jest.mock("openai", () => ({
  OpenAI: jest.fn(() => ({
    audio: {
      speech: { create: mockSpeech },
      transcriptions: { create: mockTranscription },
    },
  })),
  toFile: jest.fn(async (buffer, name) => ({ buffer, name })),
}));

const { registerMedia } = require("../../enterprise/media");
const { OpenAI } = require("openai");
const wav = Buffer.from("RIFF0000WAVEtest-audio");
const envKeys = [
  "JWT_SECRET",
  "PLATFORM_HOSTS",
  "TENANT_BASE_DOMAIN",
  "TTS_PROVIDER",
  "TTS_OPEN_AI_KEY",
  "TTS_OPEN_AI_VOICE_MODEL",
  "STT_PROVIDER",
  "OPEN_AI_KEY",
  "STT_OPEN_AI_MODEL",
];
let listener, base, previous;

function token(userId = 101, tenantId = "tenant-a", version = 1) {
  return jwt.sign(
    { identity: "tenant", tenantId, ver: version },
    process.env.JWT_SECRET,
    {
      subject: String(userId),
      audience: "enterprise-tenant-v1",
      expiresIn: "1h",
    }
  );
}

function request(
  route,
  { auth = token(), host = "media-a.localhost", body, type } = {}
) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${base}${route}`,
      {
        method: body ? "POST" : "GET",
        headers: {
          host,
          ...(auth ? { authorization: `Bearer ${auth}` } : {}),
          ...(body
            ? { "content-type": type, "content-length": body.length }
            : {}),
        },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const buffer = Buffer.concat(chunks);
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: response.headers["content-type"]?.includes("application/json")
              ? JSON.parse(buffer.toString())
              : buffer,
          });
        });
        response.on("error", reject);
      }
    );
    req.on("error", reject);
    req.end(body);
  });
}

function audio(
  buffer = Buffer.from("recording"),
  mime = "audio/webm",
  field = "audio"
) {
  const boundary = "media-test-boundary";
  return {
    type: `multipart/form-data; boundary=${boundary}`,
    body: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="voice.webm"\r\nContent-Type: ${mime}\r\n\r\n`
      ),
      buffer,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  };
}

async function message(
  id,
  content = "# Public answer\n**Hello** <think>secret reasoning</think>"
) {
  await mockStore.run(
    'INSERT INTO chats(id,"tenantId","userId",thread_id,prompt,response,"createdAt","lastUpdatedAt") VALUES($1,$2,$3,$4,$5,$6,$7::timestamp,$7::timestamp)',
    id,
    "tenant-a",
    101,
    201,
    "Question",
    JSON.stringify({ text: content, sources: [] }),
    mockStore.now()
  );
}

beforeAll(async () => {
  previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  process.env.JWT_SECRET = "isolated-media-test-secret";
  process.env.PLATFORM_HOSTS = "localhost";
  process.env.TENANT_BASE_DOMAIN = "localhost";
  mockFixture = await createPostgresFixture();
  const stamp = mockStore.now();
  for (const suffix of ["a", "b"]) {
    await mockStore.run(
      'INSERT INTO ep_tenants(id,code,name,hostname,"createdAt","updatedAt") VALUES($1,$2,$3,$2 || \'.localhost\',$4,$5)',
      `tenant-${suffix}`,
      `tenant-${suffix}`,
      `Tenant ${suffix}`,
      stamp,
      stamp
    );
    await mockStore.run(
      'UPDATE ep_tenants SET hostname=$1, "createdAt"=$3, "updatedAt"=$4 WHERE id=$2',
      `media-${suffix}.localhost`,
      `tenant-${suffix}`,
      stamp,
      stamp
    );
    await mockStore.run(
      'INSERT INTO users(id,"tenantId",username,name,"passwordHash","createdAt","lastUpdatedAt") VALUES($1,$2,$3,$4,$5,$6::timestamp,$7::timestamp)',
      suffix === "a" ? 101 : 102,
      `tenant-${suffix}`,
      "member",
      "Member",
      "unused-test-hash",
      stamp,
      stamp
    );
    await mockStore.run(
      'INSERT INTO chat_threads(id,"tenantId","userId",name,slug,"createdAt","lastUpdatedAt") VALUES($1,$2,$3,$4,$1::text,$5::timestamp,$6::timestamp)',
      suffix === "a" ? 201 : 202,
      `tenant-${suffix}`,
      suffix === "a" ? 101 : 102,
      "Private chat",
      stamp,
      stamp
    );
  }
  await mockStore.run(
    'INSERT INTO users(id,"tenantId",username,name,"passwordHash","createdAt","lastUpdatedAt") VALUES($1,$2,$3,$4,$5,$6::timestamp,$7::timestamp)',
    103,
    "tenant-a",
    "other",
    "Other member",
    "unused-test-hash",
    stamp,
    stamp
  );
  await message(9001);
  const app = express();
  registerMedia(app);
  listener = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => listener.once("listening", resolve));
  base = `http://127.0.0.1:${listener.address().port}`;
}, 15000);

beforeEach(() => {
  jest.clearAllMocks();
  process.env.TTS_PROVIDER = "openai";
  process.env.TTS_OPEN_AI_KEY = "test-tts-key";
  process.env.TTS_OPEN_AI_VOICE_MODEL = "alloy";
  process.env.STT_PROVIDER = "openai";
  process.env.OPEN_AI_KEY = "test-stt-key";
  process.env.STT_OPEN_AI_MODEL = "whisper-1";
  mockSpeech.mockImplementation(async () => ({ arrayBuffer: async () => wav }));
  mockTranscription.mockImplementation(async () => ({
    text: "Recognized speech",
  }));
  jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());
afterAll(async () => {
  if (listener) await new Promise((resolve) => listener.close(resolve));
  await mockFixture?.cleanup();
  for (const [key, value] of Object.entries(previous || {})) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("TTS reuses the original provider and markdown cleanup for the owner's assistant message", async () => {
  const response = await request("/api/enterprise/messages/9001/tts");
  expect(response.status).toBe(200);
  expect(response.body).toEqual(wav);
  expect(response.headers["content-type"]).toContain("audio/wav");
  expect(response.headers["cache-control"]).toBe("private, no-store");
  expect(OpenAI).toHaveBeenLastCalledWith({ apiKey: "test-tts-key" });
  expect(mockSpeech).toHaveBeenCalledWith({
    model: "tts-1",
    voice: "alloy",
    input: "Public answer Hello",
  });
  process.env.TTS_OPEN_AI_KEY = "updated-platform-key";
  process.env.TTS_OPEN_AI_VOICE_MODEL = "nova";
  expect((await request("/api/enterprise/messages/9001/tts")).status).toBe(200);
  expect(OpenAI).toHaveBeenLastCalledWith({ apiKey: "updated-platform-key" });
  expect(mockSpeech.mock.calls.at(-1)[0].voice).toBe("nova");
});

test("TTS never sends another user's, another tenant's or a missing message to the provider", async () => {
  for (const options of [
    { auth: token(103) },
    { auth: token(102, "tenant-b"), host: "media-b.localhost" },
  ])
    expect(
      (await request("/api/enterprise/messages/9001/tts", options)).status
    ).toBe(404);
  expect((await request("/api/enterprise/messages/missing/tts")).status).toBe(
    404
  );
  expect(mockSpeech).not.toHaveBeenCalled();
});

test("media enforces authentication, the bound tenant Host and active token version before uploads or generation", async () => {
  for (const options of [
    { auth: null },
    { host: "media-b.localhost" },
    { auth: token("user-a", "tenant-a", 0) },
  ]) {
    expect(
      (await request("/api/enterprise/messages/9001/tts", options)).status
    ).toBe(401);
    expect(
      (
        await request("/api/system/transcribe-audio", {
          ...audio(),
          ...options,
        })
      ).status
    ).toBe(401);
  }
  expect(mockSpeech).not.toHaveBeenCalled();
  expect(mockTranscription).not.toHaveBeenCalled();
});

test("TTS releases no audio after the account is disabled during provider generation", async () => {
  let started, release;
  const called = new Promise((resolve) => {
    started = resolve;
  });
  const waiting = new Promise((resolve) => {
    release = resolve;
  });
  mockSpeech.mockImplementationOnce(async () => {
    started();
    await waiting;
    return { arrayBuffer: async () => wav };
  });
  const pending = request("/api/enterprise/messages/9001/tts");
  await called;
  await mockStore.run("UPDATE users SET status='disabled' WHERE id=101");
  release();
  try {
    expect((await pending).status).toBe(401);
  } finally {
    await mockStore.run("UPDATE users SET status='active' WHERE id=101");
  }
});

test("TTS rechecks message existence after generation and rejects incomplete answers", async () => {
  await message(9002);
  mockSpeech.mockImplementationOnce(async () => {
    await mockStore.run("DELETE FROM chats WHERE id=9002");
    return { arrayBuffer: async () => wav };
  });
  expect((await request("/api/enterprise/messages/9002/tts")).status).toBe(404);
  await message(9003);
  await mockStore.run(
    `UPDATE chats SET response='{"text":"","sources":[]}' WHERE id=9003`
  );
  expect((await request("/api/enterprise/messages/9003/tts")).status).toBe(404);
});

test("empty speech text returns no content and browser TTS is handled by the client", async () => {
  await message(9004, "<think>not spoken</think>``````");
  expect((await request("/api/enterprise/messages/9004/tts")).status).toBe(204);
  for (const provider of ["native", "piper_local", ""]) {
    process.env.TTS_PROVIDER = provider;
    expect((await request("/api/enterprise/messages/9001/tts")).status).toBe(
      400
    );
  }
  expect(mockSpeech).not.toHaveBeenCalled();
});

test("STT keeps the original upload contract and uses the current platform model configuration", async () => {
  const response = await request("/api/system/transcribe-audio", audio());
  expect(response.status).toBe(200);
  expect(response.body).toEqual({ success: true, text: "Recognized speech" });
  expect(OpenAI).toHaveBeenLastCalledWith({ apiKey: "test-stt-key" });
  expect(mockTranscription.mock.calls.at(-1)[0]).toMatchObject({
    model: "whisper-1",
    file: { name: "voice.webm", buffer: Buffer.from("recording") },
  });
  process.env.STT_OPEN_AI_MODEL = "gpt-4o-mini-transcribe";
  expect((await request("/api/system/transcribe-audio", audio())).status).toBe(
    200
  );
  expect(mockTranscription.mock.calls.at(-1)[0].model).toBe(
    "gpt-4o-mini-transcribe"
  );
});

test("STT rejects nonaudio, empty, wrong-field, oversized uploads and browser mode before calling a provider", async () => {
  for (const file of [
    audio(Buffer.from("wrong"), "text/plain"),
    audio(Buffer.alloc(0)),
    audio(Buffer.from("wrong"), "audio/webm", "other"),
  ])
    expect((await request("/api/system/transcribe-audio", file)).status).toBe(
      400
    );
  expect(
    (
      await request(
        "/api/system/transcribe-audio",
        audio(Buffer.alloc(25 * 1024 * 1024 + 1))
      )
    ).status
  ).toBe(413);
  process.env.STT_PROVIDER = "native";
  expect((await request("/api/system/transcribe-audio", audio())).status).toBe(
    400
  );
  expect(mockTranscription).not.toHaveBeenCalled();
});

test("media provider failures return safe errors without leaking endpoint credentials", async () => {
  const secret = "provider-password-not-for-client";
  mockSpeech.mockRejectedValueOnce(new Error(secret));
  const tts = await request("/api/enterprise/messages/9001/tts");
  expect(tts.status).toBe(502);
  expect(JSON.stringify(tts.body)).not.toContain(secret);
  mockTranscription.mockRejectedValueOnce(new Error(secret));
  const stt = await request("/api/system/transcribe-audio", audio());
  expect(stt.status).toBe(502);
  expect(JSON.stringify(stt.body)).not.toContain(secret);
});
