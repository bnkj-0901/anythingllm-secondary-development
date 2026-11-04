// Follow the admin ThoughtContainer tag formats; this parser stays local to uni-app.
const THOUGHT_TAG =
  /^<(\/)?(think|thinking|thought|thought_chain)(?=\s|>)(?:\s[^<>]*?)?\s*>/i;
const ANSWER_END_TAG = /^<\/(?:response|answer)\s*>/i;

function trailingTagPrefix(value, inThought) {
  const candidates = ["think", "thinking", "thought", "thought_chain"].flatMap(
    (name) => [`<${name}>`, `</${name}>`]
  );
  if (inThought) candidates.push("</response>", "</answer>");
  const lower = value.toLowerCase();
  return (
    candidates.some((tag) => tag.startsWith(lower)) ||
    /^<\/?(?:think|thinking|thought|thought_chain)\s[^<>]*$/i.test(value)
  );
}

/**
 * The server stores provider reasoning inside thought tags. Split only those
 * tags, wherever they occur; code examples retain literal tags. Re-evaluating
 * the accumulated content also handles delimiters split over SSE chunks.
 */
export function splitMessageReasoning(message = {}) {
  const raw = typeof message.content === "string" ? message.content : "";
  let content = "",
    thought = "",
    depth = 0,
    fence = "",
    ticks = 0;
  let sawThought = false,
    hiddenTag = false;
  const append = (value) => {
    if (depth) thought += value;
    else content += value;
  };
  for (let index = 0; index < raw.length; ) {
    if (index === 0 || raw[index - 1] === "\n") {
      const lineEnd = raw.indexOf("\n", index);
      const end = lineEnd < 0 ? raw.length : lineEnd + 1;
      const line = raw.slice(index, end);
      const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
      if (fence) {
        append(line);
        if (
          marker &&
          marker[1][0] === fence[0] &&
          marker[1].length >= fence.length &&
          line.slice(marker[0].length).trim() === ""
        )
          fence = "";
        index = end;
        continue;
      }
      if (marker && !ticks) {
        fence = marker[1];
        append(line);
        index = end;
        continue;
      }
    }
    if (!ticks && raw[index] === "\\" && index + 1 < raw.length) {
      // Markdown escapes protect literal delimiters, including backticks.
      append(raw.slice(index, index + 2));
      index += 2;
      continue;
    }
    if (raw[index] === "`") {
      const run = raw.slice(index).match(/^`+/)[0];
      if (!ticks) ticks = run.length;
      else if (ticks === run.length) ticks = 0;
      append(run);
      index += run.length;
      continue;
    }
    if (!ticks && raw[index] === "<") {
      const rest = raw.slice(index);
      const tag = rest.match(THOUGHT_TAG);
      const answerEnd = depth && rest.match(ANSWER_END_TAG);
      if (tag) {
        if (!tag[1]) {
          if (!depth && thought) thought += "\n\n";
          depth++;
          sawThought = true;
        } else if (depth) depth--;
        index += tag[0].length;
        continue;
      }
      if (answerEnd) {
        depth = 0;
        index += answerEnd[0].length;
        continue;
      }
      if (message.pending && trailingTagPrefix(rest, depth > 0)) {
        hiddenTag = true;
        break;
      }
    }
    append(raw[index++]);
  }
  const separate =
    typeof message.reasoning === "string"
      ? message.reasoning
      : typeof message.reasoning_content === "string"
        ? message.reasoning_content
        : "";
  // Some providers expose the same reasoning in both formats.
  const reasoning =
    separate && thought.trim() !== separate.trim()
      ? [separate, thought].filter(Boolean).join("\n\n")
      : thought || separate;
  return {
    content,
    reasoning,
    hasReasoning: sawThought || !!reasoning || !!message.reasoningPending,
    thinking:
      !!message.pending &&
      (depth > 0 || hiddenTag || !!message.reasoningPending),
  };
}

// Independent reasoning events are deltas, while the final reasoning field is
// a complete snapshot. A control-only done event is valid and adds no text.
export function reasoningEventText(event = {}) {
  for (const key of [
    "text",
    "reasoning",
    "reasoning_content",
    "textResponse",
    "content",
    "delta",
  ]) {
    if (typeof event[key] === "string") return event[key];
  }
  return "";
}

export function reasoningEventDone(event = {}) {
  return (
    event.done === true || event.close === true || event.status === "completed"
  );
}
