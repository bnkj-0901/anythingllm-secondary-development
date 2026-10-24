const mockRerank = jest.fn();
jest.mock("../../utils/EmbeddingRerankers/native", () => ({
  NativeEmbeddingReranker: jest
    .fn()
    .mockImplementation(() => ({ rerank: mockRerank })),
}));
const { rerank } = require("../../enterprise/rerank");
const {
  NativeEmbeddingReranker,
} = require("../../utils/EmbeddingRerankers/native");

beforeEach(() => mockRerank.mockReset());

test("empty authorized results do not construct or invoke the reranker", async () => {
  expect(await rerank("question", [])).toEqual([]);
  expect(NativeEmbeddingReranker).not.toHaveBeenCalled();
});

test("original reranker order becomes citation order and keeps source metadata", async () => {
  const sources = [
    { id: "one", text: "first", citationNumber: 1 },
    { id: "two", text: "second", citationNumber: 2 },
  ];
  const controller = new AbortController();
  mockRerank.mockResolvedValue([sources[1], sources[0]]);
  expect(
    await rerank("question", sources, { topK: 2, signal: controller.signal })
  ).toEqual([
    { ...sources[1], citationNumber: 1 },
    { ...sources[0], citationNumber: 2 },
  ]);
  expect(mockRerank).toHaveBeenCalledWith("question", sources, {
    topK: 2,
    signal: controller.signal,
  });
  mockRerank.mockResolvedValue([]);
  expect(await rerank("no match", sources)).toEqual([]);
  expect(NativeEmbeddingReranker).toHaveBeenCalledTimes(1);
});

test("model failures keep the original empty-source fallback", async () => {
  mockRerank.mockRejectedValue(
    new Error("internal model path with credentials")
  );
  const log = jest.spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(await rerank("question", [{ id: "one" }])).toEqual([]);
    expect(log.mock.calls.flat().join(" ")).not.toMatch(
      /credentials|model path/
    );
  } finally {
    log.mockRestore();
  }
});

test("cancellation before and during inference never returns or masks cancelled results", async () => {
  const before = new AbortController();
  const reason = new Error("request cancelled");
  before.abort(reason);
  await expect(
    rerank("question", [{ id: "one" }], { signal: before.signal })
  ).rejects.toBe(reason);
  expect(mockRerank).not.toHaveBeenCalled();
  const during = new AbortController();
  mockRerank.mockImplementation(async () => {
    during.abort(reason);
    return [{ id: "late" }];
  });
  await expect(
    rerank("question", [{ id: "one" }], { signal: during.signal })
  ).rejects.toBe(reason);
});
