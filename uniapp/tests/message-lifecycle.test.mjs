import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { computed, ref } from "vue";

function harness() {
  const source = readFileSync(
    new URL("../src/pages/index/index.vue", import.meta.url),
    "utf8"
  )
    .split("<script setup>")[1]
    .split("</script>")[0]
    .replace(/^import[\s\S]*?;\r?\n/gm, "");
  let emit,
    resolve,
    reject,
    cancelled = 0;
  const request = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  request.cancel = () => {
    cancelled++;
  };
  const api = {
    getEndpoint: () => "https://acme.example.com/api",
    conversations: async () => ({ conversations: [{ id: "c1" }] }),
    streamMessage(_id, _text, onEvent) {
      emit = onEvent;
      return request;
    },
  };
  const page = new Function(
    "computed",
    "nextTick",
    "onBeforeUnmount",
    "onMounted",
    "inject",
    "ref",
    "onResize",
    "onShow",
    "uni",
    `${source}\nreturn {sendMessage,stopMessage,session,messages,currentConversation,sending,sendError};`
  )(
    computed,
    async () => {},
    () => {},
    () => {},
    () => api,
    ref,
    () => {},
    () => {},
    {}
  );
  page.session.value = { user: { id: 1 }, tenant: { id: "tenant-a" } };
  page.currentConversation.value = { id: "c1" };
  return {
    ...page,
    emit: (event) => emit(event),
    resolve,
    reject,
    cancelled: () => cancelled,
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

for (const stopped of [false, true]) {
  test(`index handler clears unfinished answer and reasoning after ${stopped ? "cancellation" : "failure"}`, async () => {
    const h = harness();
    const pending = h.sendMessage("问题");
    await tick();
    h.emit({ type: "reasoning", text: "未完成思考", done: false });
    h.emit({ type: "delta", text: "未完成回答" });
    h.emit({ type: "reasoning", text: "继续思考", done: false });
    const preview = h.messages.value[1];
    assert.equal(preview.content, "未完成回答");
    assert.equal(preview.reasoning, "未完成思考继续思考");
    assert.equal(preview.reasoningPending, true);
    if (stopped) h.stopMessage();
    else h.reject(new Error("模型连接中断"));
    await pending;
    const result = h.messages.value[1];
    assert.equal(result.content, "");
    assert.equal(result.reasoning, "");
    assert.equal(result.reasoningPending, false);
    assert.equal(result.pending, false);
    assert.equal(result.localId, preview.localId);
    assert.equal(result.interrupted, stopped);
    assert.equal(result.error, stopped ? "" : "模型连接中断");
    assert.equal(h.sendError.value, stopped ? "" : "模型连接中断");
    assert.equal(h.sending.value, false);
    assert.equal(h.cancelled(), stopped ? 1 : 0);
    if (stopped) {
      h.emit({ type: "reasoning", text: "迟到思考", done: false });
      h.emit({ type: "delta", text: "迟到回答" });
      h.resolve({
        message: { id: 123, role: "assistant", content: "迟到最终回答" },
      });
      await tick();
      assert.equal(h.messages.value[1].content, "");
      assert.equal(h.messages.value[1].reasoning, "");
    }
  });
}

test("index handler commits final reasoning and keeps the preview component identity", async () => {
  const h = harness();
  const pending = h.sendMessage("问题");
  await tick();
  h.emit({ type: "reasoning", text: "预览思考", done: false });
  const localId = h.messages.value[1].localId;
  h.resolve({
    message: {
      id: 123,
      role: "assistant",
      content: "最终回答",
      reasoning: "完整思考",
      sources: [],
    },
  });
  await pending;
  assert.equal(h.messages.value[1].id, 123);
  assert.equal(h.messages.value[1].localId, localId);
  assert.equal(h.messages.value[1].content, "最终回答");
  assert.equal(h.messages.value[1].reasoning, "完整思考");
  assert.equal(h.messages.value[1].pending, false);
});
