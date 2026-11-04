import test from "node:test";
import assert from "node:assert/strict";
import { splitMessageReasoning } from "../src/utils/reasoning.mjs";
import { createAnswerStream } from "../src/services/enterprise-stream.mjs";

const event = (value) => `data: ${JSON.stringify(value)}\n\n`;

test("escaped thought tag examples remain visible answer content", () => {
  const literal = "\\<think>示例\\</think>";
  assert.equal(splitMessageReasoning({ content: literal }).content, literal);
  assert.equal(splitMessageReasoning({ content: literal }).hasReasoning, false);
});

test("reasoning is separated anywhere in an answer and across multiple thought blocks", () => {
  const result = splitMessageReasoning({
    content:
      "先给结论。<think>检查资料</think>正文。<THOUGHT_CHAIN mode='brief'>再检查</THOUGHT_CHAIN>结束。",
  });
  assert.deepEqual(result, {
    content: "先给结论。正文。结束。",
    reasoning: "检查资料\n\n再检查",
    hasReasoning: true,
    thinking: false,
  });
});

test("every streaming delimiter boundary keeps reasoning out of the visible answer", () => {
  for (const tag of ["think", "thinking", "thought", "thought_chain"]) {
    const raw = `前文。<${tag}>思考内容</${tag}>最终答案`;
    for (let end = 0; end <= raw.length; end++) {
      const content = raw.slice(0, end);
      const result = splitMessageReasoning({ content, pending: true });
      assert(!result.content.includes("思考"), `${tag} boundary ${end}`);
      assert(!result.content.includes("<"), `${tag} boundary ${end}`);
      if (content.includes(`</${tag}>`)) assert.equal(result.thinking, false);
      if (content.includes("思考") && !content.includes(`</${tag}>`))
        assert.equal(result.thinking, true);
    }
  }
});

test("unfinished thought stays separate and only an active stream shows the thinking state", () => {
  const content = "<think>需要核对参数";
  const active = splitMessageReasoning({ content, pending: true });
  assert.equal(active.content, "");
  assert.equal(active.reasoning, "需要核对参数");
  assert.equal(active.thinking, true);
  const stopped = splitMessageReasoning({
    content,
    interrupted: true,
    pending: false,
  });
  assert.equal(stopped.reasoning, active.reasoning);
  assert.equal(stopped.thinking, false);
});

test("literal thought tags in fenced and inline code remain answer text", () => {
  const content =
    "示例 `<think>保留</think>`：\n```html\n<think>代码</think>\n```\n<think>真实思考</think>答案";
  const result = splitMessageReasoning({ content });
  assert.equal(result.reasoning, "真实思考");
  assert(result.content.includes("`<think>保留</think>`"));
  assert(result.content.includes("<think>代码</think>"));
  assert(!result.content.includes("真实思考"));
  const tilde = "~~~html\n<thinking>示例\n~~~\n正文";
  assert.equal(splitMessageReasoning({ content: tilde }).content, tilde);
});

test("stored reasoning fields render separately without duplication", () => {
  for (const field of ["reasoning", "reasoning_content"]) {
    const result = splitMessageReasoning({
      content: "回答",
      [field]: "历史思考",
    });
    assert.equal(result.reasoning, "历史思考");
    assert.equal(result.content, "回答");
  }
  assert.equal(
    splitMessageReasoning({
      content: "<think>相同思考</think>回答",
      reasoning: "相同思考",
    }).reasoning,
    "相同思考"
  );
});

test("independent reasoning SSE deltas survive final responses without a reasoning field", () => {
  const events = [];
  const parser = createAnswerStream((value) => events.push(value));
  parser.append(event({ type: "reasoning", content: "核对" }));
  parser.append(event({ type: "reasoning", textResponse: "资料" }));
  parser.append(event({ type: "reasoning", done: true }));
  parser.append(event({ type: "textResponseChunk", textResponse: "回答" }));
  parser.append(
    event({
      type: "finalizeResponseStream",
      message: {
        id: 9,
        role: "assistant",
        content: "回答",
        sources: [],
      },
    })
  );
  const result = parser.finish();
  assert.equal(result.message.reasoning, "核对资料");
  assert.deepEqual(
    events.slice(0, 3).map(({ text, done }) => ({ text, done })),
    [
      { text: "核对", done: false },
      { text: "资料", done: false },
      { text: "", done: true },
    ]
  );
  assert.equal(splitMessageReasoning(result.message).reasoning, "核对资料");
});

test("final reasoning snapshots replace partial SSE reasoning rather than duplicate it", () => {
  for (const final of [
    {
      message: {
        id: 10,
        role: "assistant",
        content: "答案",
        reasoning: "完整思考",
      },
    },
    { chatId: 10, textResponse: "答案", reasoning: "完整思考" },
  ]) {
    const parser = createAnswerStream(() => {});
    parser.append(event({ type: "reasoning", text: "完整" }));
    parser.append(event({ type: "finalizeResponseStream", ...final }));
    assert.equal(parser.finish().message.reasoning, "完整思考");
  }
});
