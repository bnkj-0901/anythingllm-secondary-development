// Helpers that convert authorized chats to some supported format
// for external use by the user.

const { Chat, chatScope } = require("../../../models/workspaceChats");
const { ChatThread } = require("../../../models/workspaceThread");
const { EmbedChats } = require("../../../models/embedChats");
const { safeJsonParse } = require("../../http");
const { SystemSettings } = require("../../../models/systemSettings");

async function convertToCSV(preparedData) {
  const headers = new Set(["id", "workspace", "prompt", "response", "sent_at"]);
  preparedData.forEach((item) =>
    Object.keys(item).forEach((key) => headers.add(key))
  );

  const rows = [Array.from(headers).join(",")];

  for (const item of preparedData) {
    const record = Array.from(headers)
      .map((header) => {
        const value = item[header] ?? "";
        return escapeCsv(String(value));
      })
      .join(",");
    rows.push(record);
  }
  return rows.join("\n");
}

async function convertToJSON(preparedData) {
  return JSON.stringify(preparedData, null, 4);
}

// ref: https://raw.githubusercontent.com/gururise/AlpacaDataCleaned/main/alpaca_data.json
async function convertToJSONAlpaca(preparedData) {
  return JSON.stringify(preparedData, null, 4);
}

// You can validate JSONL outputs on https://jsonlines.org/validator/
async function convertToJSONL(workspaceChatsMap) {
  return Object.values(workspaceChatsMap)
    .map((workspaceChats) => JSON.stringify(workspaceChats))
    .join("\n");
}

async function prepareChatsForExport(
  format = "jsonl",
  chatType = "personal",
  ctx,
  { threadId } = {}
) {
  if (!exportMap.hasOwnProperty(format))
    throw new Error(`Invalid export type: ${format}`);

  let chats;
  if (chatType === "personal") {
    chatScope(ctx);
    const threads = await ChatThread.where(
      ctx,
      threadId ? { id: Number(threadId) } : {}
    );
    if (threadId && !threads.length)
      throw Object.assign(new Error("对话不存在或无权访问"), { status: 404 });
    const byId = new Map(threads.map((thread) => [thread.id, thread]));
    const prompt = await tenantPrompt(ctx);
    chats = (
      await Chat.where(
        ctx,
        {
          thread_id: { in: threads.map((thread) => thread.id) },
        },
        { orderBy: { id: "asc" } }
      )
    ).map((chat) => ({
      ...chat,
      exportGroupId: chat.thread_id,
      conversationName:
        byId.get(chat.thread_id)?.name || "unknown conversation",
      systemPrompt: prompt,
    }));
  } else if (chatType === "embed") {
    if (
      ctx?.identity !== "platform" &&
      (ctx?.identity !== "tenant" || ctx.role !== "admin" || !ctx.tenantId)
    )
      throw Object.assign(new Error("需要管理员权限"), { status: 403 });
    chats = await EmbedChats.whereWithEmbedAndLibrary(
      ctx.identity === "platform"
        ? {}
        : { embed_config: { tenantId: ctx.tenantId } },
      null,
      {
        id: "asc",
      },
      null
    );
    const prompts = new Map();
    chats = await Promise.all(
      chats.map(async (chat) => {
        const tenantId = chat.embed_config.tenantId;
        if (!prompts.has(tenantId))
          prompts.set(tenantId, tenantPrompt({ identity: "embed", tenantId }));
        return {
          ...chat,
          exportGroupId: chat.embed_id,
          conversationName:
            chat.embed_config.library?.name || "unknown library",
          systemPrompt: await prompts.get(tenantId),
        };
      })
    );
  } else {
    throw new Error(`Invalid chat type: ${chatType}`);
  }

  // Reserved Agent rows are not completed answers. Reset snapshots remain
  // exportable, independently of whether they are used in model context.
  chats = chats.filter((chat) => {
    const response = safeJsonParse(chat.response, {});
    return (
      typeof chat.prompt === "string" &&
      chat.prompt.trim() &&
      typeof response?.text === "string" &&
      response.text.trim()
    );
  });

  if (format === "csv" || format === "json") {
    const preparedData = chats.map((chat) => {
      const responseJson = safeJsonParse(chat.response, {});
      const baseData = {
        id: chat.id,
        prompt: chat.prompt,
        response: responseJson.text,
        sent_at: chat.createdAt,
        // Only add attachments to the json format since we cannot arrange attachments in csv format
        ...(format === "json"
          ? {
              attachments:
                responseJson.attachments?.length > 0
                  ? responseJson.attachments.map((attachment) => ({
                      type: "image",
                      image: attachmentToDataUrl(attachment),
                    }))
                  : [],
            }
          : {}),
      };

      if (chatType === "embed") {
        return {
          ...baseData,
          workspace: chat.conversationName,
        };
      }

      return {
        ...baseData,
        // Keep this legacy export column for consumers of the original format;
        // its value is a personal conversation name, not a Workspace entity.
        workspace: chat.conversationName,
        username:
          ctx.user?.username ||
          ctx.username ||
          (chat.api_session_id !== null ? "API" : "unknown user"),
        rating:
          chat.feedbackScore === null
            ? "--"
            : chat.feedbackScore
              ? "GOOD"
              : "BAD",
      };
    });

    return preparedData;
  }

  // jsonAlpaca format does not support array outputs
  if (format === "jsonAlpaca") {
    const preparedData = chats.map((chat) => {
      const responseJson = safeJsonParse(chat.response, {});
      return {
        instruction: buildSystemPrompt(chat, chat.systemPrompt),
        input: chat.prompt,
        output: responseJson.text,
      };
    });

    return preparedData;
  }

  // Export to JSONL format (recommended for fine-tuning)
  const workspaceChatsMap = chats.reduce((acc, chat) => {
    const { prompt, response, exportGroupId } = chat;
    const responseJson = safeJsonParse(response, { attachments: [] });
    const attachments = responseJson.attachments;

    if (!acc[exportGroupId]) {
      acc[exportGroupId] = {
        messages: [
          {
            role: "system",
            content: [
              {
                type: "text",
                text:
                  chat.systemPrompt ?? SystemSettings.saneDefaultSystemPrompt,
              },
            ],
          },
        ],
      };
    }

    acc[exportGroupId].messages.push(
      {
        role: "user",
        content: [
          {
            type: "text",
            text: prompt,
          },
          ...(attachments?.length > 0
            ? attachments.map((attachment) => ({
                type: "image",
                image: attachmentToDataUrl(attachment),
              }))
            : []),
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: responseJson.text,
          },
        ],
      }
    );

    return acc;
  }, {});

  return workspaceChatsMap;
}

const exportMap = {
  json: {
    contentType: "application/json",
    func: convertToJSON,
  },
  csv: {
    contentType: "text/csv",
    func: convertToCSV,
  },
  jsonl: {
    contentType: "application/jsonl",
    func: convertToJSONL,
  },
  jsonAlpaca: {
    contentType: "application/json",
    func: convertToJSONAlpaca,
  },
};

function escapeCsv(str) {
  if (str === null || str === undefined) return '""';
  // Prefix formula-leading characters so spreadsheets treat the cell as text (CWE-1236).
  if (/^[=+\-@\t\r]/.test(str)) str = `'${str}`;
  return `"${str.replace(/"/g, '""').replace(/\n/g, " ")}"`;
}

async function exportChatsAsType(
  format = "jsonl",
  chatType = "personal",
  ctx,
  options
) {
  const { contentType, func } = exportMap.hasOwnProperty(format)
    ? exportMap[format]
    : exportMap.jsonl;
  const chats = await prepareChatsForExport(format, chatType, ctx, options);
  return {
    contentType,
    data: await func(chats),
  };
}

async function tenantPrompt(ctx) {
  const configuration =
    await require("../../../enterprise/rag-settings").getSettings(ctx.tenantId);
  return (
    configuration.openAiPrompt ??
    require("../../../enterprise/settings").defaultPrompt(ctx)
  );
}

function buildSystemPrompt(chat, prompt = null) {
  const sources = safeJsonParse(chat.response)?.sources || [];
  const contextTexts = sources.map((source) => source.text);
  const context =
    sources.length > 0
      ? "\nContext:\n" +
        contextTexts
          .map((text, i) => {
            return `[CONTEXT ${i}]:\n${text}\n[END CONTEXT ${i}]\n\n`;
          })
          .join("")
      : "";
  return `${prompt ?? SystemSettings.saneDefaultSystemPrompt}${context}`;
}

/**
 * Converts an attachment's content string to a proper data URL format if needed
 * @param {Object} attachment - The attachment object containing contentString and mime type
 * @returns {string} The properly formatted data URL
 */
function attachmentToDataUrl(attachment) {
  return attachment.contentString.startsWith("data:")
    ? attachment.contentString
    : `data:${attachment.mime};base64,${attachment.contentString}`;
}

const validExportTypes = ["json", "csv", "jsonl", "jsonAlpaca"];

module.exports = {
  prepareChatsForExport,
  exportChatsAsType,
  validExportTypes,
};
