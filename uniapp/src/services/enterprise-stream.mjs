import { ChatEventParser, Utf8Decoder } from "./stream.mjs";

// Consume the original AnythingLLM event contract using the existing transport parser.
export function createUtf8Decoder() {
  const decoder = new Utf8Decoder();
  return (chunk, final = false) =>
    decoder.decode(chunk || new Uint8Array(0), final);
}
export function createAnswerStream(onEvent) {
  let completed = false;
  let message;
  const parser = new ChatEventParser((event) => {
    if (completed) throw new Error("回答完成后收到额外数据");
    if (event.type === "error" || event.type === "abort")
      throw new Error(
        typeof event.error === "string" ? event.error : "回答生成失败"
      );
    if (event.type === "finalizeResponseStream") {
      let value = event.message || {id:event.chatId || event.uuid,role:"assistant",content:event.textResponse || "",sources:event.sources || []};
      // Commands such as /reset return an ephemeral answer rather than a saved
      // chat record. Use its event UUID only as the local rendering identity.
      if (value.ephemeral === true && !value.id && typeof event.id === "string")
        value = { ...value, id: event.id };
      // Saved chats retain the original integer ID; command answers use a UUID.
      const validId =
        (typeof value?.id === "string" && value.id.length > 0) ||
        (Number.isSafeInteger(value?.id) && value.id > 0);
      if (
        !value ||
        !validId ||
        value.role !== "assistant" ||
        typeof value.content !== "string" ||
        !value.content.trim() ||
        (value.sources !== undefined && !Array.isArray(value.sources))
      )
        throw new Error("服务没有返回有效的最终回答，请重试");
      message = value;
      completed = true;
    } else if (["textResponseChunk", "textResponse"].includes(event.type)) {
      if (typeof event.textResponse !== "string") throw new Error("回答片段格式无效");
      onEvent({type:"delta",text:event.textResponse});
    } else if (["start", "modelRouteNotification", "reasoning", "imageGenerationPending"].includes(event.type)) onEvent(event);
    else throw new Error("回答事件类型无效");
  });
  return {
    append: (text) => parser.push(text),
    finish() {
      parser.finish();
      if (!completed) throw new Error("回答连接中断，请重试此问题");
      onEvent({ type: "done", message });
      return { message };
    },
  };
}
