const { SystemSettings } = require("../models/systemSettings");
const { validatedRequest } = require("../utils/middleware/validatedRequest");
const {
  validExportTypes,
  sendChatHistoryFile,
} = require("../utils/chats/exportChatToFile");
const { safeJsonParse } = require("../utils/http");
const { ChatThread } = require("../models/workspaceThread");
const { Chat } = require("../models/workspaceChats");

function registerChatExport(app, { authenticate = validatedRequest } = {}) {
  app.post(
    "/conversations/:id/export/:type",
    authenticate,
    async (request, response, next) => {
      try {
        const { type, id } = request.params;
        if (!validExportTypes.includes(type))
          return response.status(400).json({ error: "不支持的导出格式" });
        const conversation = await ChatThread.get(request.ep, { id: Number(id) });
        if (!conversation)
          return response.status(404).json({ error: "对话不存在或无权访问" });
        const chats = (
          await Chat.forThread(request.ep, conversation.id, { include: true })
        ).filter((chat) => {
          const data = safeJsonParse(chat.response, {});
          return (
            typeof chat.prompt === "string" &&
            chat.prompt.trim() &&
            typeof data?.text === "string" &&
            data.text.trim()
          );
        });
        if (!chats.length)
          return response.status(400).json({ error: "对话尚无可导出的消息" });
        return await sendChatHistoryFile(
          response,
          chats,
          { conversationName: conversation.name },
          type
        );
      } catch (error) {
        next(error);
      }
    }
  );
}

function utilEndpoints(app) {
  if (!app) return;

  app.get("/utils/metrics", async (_, response) => {
    try {
      const metrics = {
        online: true,
        version: getGitVersion(),
        mode: (await SystemSettings.isMultiUserMode())
          ? "multi-user"
          : "single-user",
        vectorDB: process.env.VECTOR_DB || "lancedb",
        storage: await getDiskStorage(),
        appVersion: getDeploymentVersion(),
      };
      response.status(200).json(metrics);
    } catch (e) {
      console.error(e);
      response.sendStatus(500).end();
    }
  });

  registerChatExport(app);

  const { lemonadeUtilsEndpoints } = require("./utils/lemonadeUtilsEndpoints");
  lemonadeUtilsEndpoints(app);

  const {
    embeddedLemonadeEndpoints,
  } = require("../utils/AiProviders/embeddedLemonade/endpoints");
  embeddedLemonadeEndpoints(app);

  const { foundryUtilsEndpoints } = require("./utils/foundryUtilsEndpoints");
  foundryUtilsEndpoints(app);
}

function getGitVersion() {
  if (process.env.ANYTHING_LLM_RUNTIME === "docker") return "--";
  try {
    return require("child_process")
      .execSync("git rev-parse HEAD")
      .toString()
      .trim();
  } catch (e) {
    console.error("getGitVersion", e.message);
    return "--";
  }
}

function byteToGigaByte(n) {
  return n / Math.pow(10, 9);
}

async function getDiskStorage() {
  try {
    const checkDiskSpace = require("check-disk-space").default;
    const { free, size } = await checkDiskSpace("/");
    return {
      current: Math.floor(byteToGigaByte(free)),
      capacity: Math.floor(byteToGigaByte(size)),
    };
  } catch {
    return {
      current: null,
      capacity: null,
    };
  }
}

/**
 * Returns the model tag based on the provider set in the environment.
 * This information is used to identify the parent model for the system
 * so that we can prioritize the correct model and types for future updates
 * as well as build features in AnythingLLM directly for a specific model or capabilities.
 *
 * Disable with  {@link https://github.com/Mintplex-Labs/anything-llm?tab=readme-ov-file#telemetry--privacy|Disable Telemetry}
 * @returns {string} The model tag.
 */
function getModelTag() {
  let model = null;
  const provider = process.env.LLM_PROVIDER;

  switch (provider) {
    case "openai":
      model = process.env.OPEN_MODEL_PREF;
      break;
    case "anthropic":
      model = process.env.ANTHROPIC_MODEL_PREF;
      break;
    case "lmstudio":
      model = process.env.LMSTUDIO_MODEL_PREF;
      break;
    case "ollama":
      model = process.env.OLLAMA_MODEL_PREF;
      break;
    case "groq":
      model = process.env.GROQ_MODEL_PREF;
      break;
    case "togetherai":
      model = process.env.TOGETHER_AI_MODEL_PREF;
      break;
    case "azure":
      model =
        process.env.AZURE_OPENAI_MODEL_PREF || process.env.OPEN_MODEL_PREF;
      break;
    case "koboldcpp":
      model = process.env.KOBOLD_CPP_MODEL_PREF;
      break;
    case "localai":
      model = process.env.LOCAL_AI_MODEL_PREF;
      break;
    case "openrouter":
      model = process.env.OPENROUTER_MODEL_PREF;
      break;
    case "mistral":
      model = process.env.MISTRAL_MODEL_PREF;
      break;
    case "generic-openai":
      model = process.env.GENERIC_OPEN_AI_MODEL_PREF;
      break;
    case "perplexity":
      model = process.env.PERPLEXITY_MODEL_PREF;
      break;
    case "textgenwebui":
      model = "textgenwebui-default";
      break;
    case "bedrock":
      model = process.env.AWS_BEDROCK_LLM_MODEL_PREFERENCE;
      break;
    case "fireworksai":
      model = process.env.FIREWORKS_AI_LLM_MODEL_PREF;
      break;
    case "deepseek":
      model = process.env.DEEPSEEK_MODEL_PREF;
      break;
    case "litellm":
      model = process.env.LITE_LLM_MODEL_PREF;
      break;
    case "apipie":
      model = process.env.APIPIE_LLM_MODEL_PREF;
      break;
    case "xai":
      model = process.env.XAI_LLM_MODEL_PREF;
      break;
    case "novita":
      model = process.env.NOVITA_LLM_MODEL_PREF;
      break;
    case "nvidia-nim":
      model = process.env.NVIDIA_NIM_LLM_MODEL_PREF;
      break;
    case "ppio":
      model = process.env.PPIO_MODEL_PREF;
      break;
    case "gemini":
      model = process.env.GEMINI_LLM_MODEL_PREF;
      break;
    case "moonshotai":
      model = process.env.MOONSHOT_AI_MODEL_PREF;
      break;
    case "zai":
      model = process.env.ZAI_MODEL_PREF;
      break;
    case "giteeai":
      model = process.env.GITEE_AI_MODEL_PREF;
      break;
    case "cohere":
      model = process.env.COHERE_MODEL_PREF;
      break;
    case "llmman":
      model = process.env.LLMMAN_MODEL_PREF;
      break;
    case "privatemode":
      model = process.env.PRIVATEMODE_LLM_MODEL_PREF;
      break;
    case "sambanova":
      model = process.env.SAMBANOVA_LLM_MODEL_PREF;
      break;
    case "lemonade":
      model = process.env.LEMONADE_LLM_MODEL_PREF;
      break;
    case "embedded_lemonade":
      model = process.env.EMBEDDED_LEMONADE_MODEL_PREF;
      break;
    case "minimax":
      model = process.env.MINIMAX_MODEL_PREF;
      break;
    case "cerebras":
      model = process.env.CEREBRAS_MODEL_PREF;
      break;
    case "omlx":
      model = process.env.OMLX_LLM_MODEL_PREF;
      break;
    case "vertex":
      model = process.env.VERTEX_AI_LLM_MODEL_PREF;
      break;
    default:
      model = "--";
      break;
  }
  return model;
}

/**
 * Returns the deployment version.
 * - Dev: reads from package.json
 * - Prod: reads from ENV
 * expected format: major.minor.patch
 * @returns {string|null} The deployment version.
 */
function getDeploymentVersion() {
  if (process.env.NODE_ENV === "development")
    return require("../../package.json").version;
  if (process.env.DEPLOYMENT_VERSION) return process.env.DEPLOYMENT_VERSION;
  return null;
}

/**
 * Returns the user agent for the AnythingLLM deployment.
 * @returns {string} The user agent.
 */
function getAnythingLLMUserAgent() {
  const version = getDeploymentVersion() || "unknown";
  return `AnythingLLM/${version}`;
}

module.exports = {
  utilEndpoints,
  registerChatExport,
  getGitVersion,
  getModelTag,
  getAnythingLLMUserAgent,
  getDeploymentVersion,
};
