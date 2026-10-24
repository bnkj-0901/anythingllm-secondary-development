const {
  env,
  sdkOptions,
} = require("../../../enterprise/ai/connection-context");
const {
  toChunks,
  maximumChunkLength,
  reportEmbeddingProgress,
} = require("../../helpers");

class LocalAiEmbedder {
  constructor() {
    if (!env.EMBEDDING_BASE_PATH)
      throw new Error("No embedding base path was set.");
    if (!env.EMBEDDING_MODEL_PREF)
      throw new Error("No embedding model was set.");

    this.className = "LocalAiEmbedder";
    const { OpenAI: OpenAIApi } = require("openai");
    this.model = env.EMBEDDING_MODEL_PREF;
    this.openai = new OpenAIApi(
      sdkOptions({
        baseURL: env.EMBEDDING_BASE_PATH,
        apiKey: env.LOCAL_AI_API_KEY ?? null,
      })
    );

    // Limit of how many strings we can process in a single pass to stay with resource or network limits
    this.maxConcurrentChunks = 50;
    this.embeddingMaxChunkLength = maximumChunkLength();

    this.log(
      `Initialized with ${this.model} - Max Size: ${this.embeddingMaxChunkLength}` +
        (this.outputDimensions
          ? ` - Output Dimensions: ${this.outputDimensions}`
          : " Assuming default output dimensions")
    );
  }

  log(text, ...args) {
    console.log(`\x1b[36m[${this.className}]\x1b[0m ${text}`, ...args);
  }

  get outputDimensions() {
    if (
      env.EMBEDDING_OUTPUT_DIMENSIONS &&
      !isNaN(env.EMBEDDING_OUTPUT_DIMENSIONS) &&
      env.EMBEDDING_OUTPUT_DIMENSIONS > 0
    )
      return parseInt(env.EMBEDDING_OUTPUT_DIMENSIONS);
    return null;
  }

  async embedTextInput(textInput) {
    const result = await this.embedChunks(
      Array.isArray(textInput) ? textInput : [textInput]
    );
    return result?.[0] || [];
  }

  async embedChunks(textChunks = []) {
    const embeddingRequests = [];
    let chunksProcessed = 0;
    for (const chunk of toChunks(textChunks, this.maxConcurrentChunks)) {
      embeddingRequests.push(
        new Promise((resolve) => {
          // Dev: LocalAI versions < v2.29 ignored encoding_format and always returned float arrays,
          // causing the OpenAI SDK's default base64 decode to silently produce dims/4 zero vectors.
          // Fixed in LocalAI PR #9135 (Mar 2026). Pinning "float" here for safety with older versions.
          this.openai.embeddings
            .create({
              model: this.model,
              input: chunk,
              dimensions: this.outputDimensions,
              encoding_format: "float",
            })
            .then((result) => {
              chunksProcessed += chunk.length;
              reportEmbeddingProgress(chunksProcessed, textChunks.length);
              resolve({ data: result?.data, error: null });
            })
            .catch((e) => {
              chunksProcessed += chunk.length;
              reportEmbeddingProgress(chunksProcessed, textChunks.length);
              e.type =
                e?.response?.data?.error?.code ||
                e?.response?.status ||
                "failed_to_embed";
              e.message = e?.response?.data?.error?.message || e.message;
              resolve({ data: [], error: e });
            });
        })
      );
    }

    const { data = [], error = null } = await Promise.all(
      embeddingRequests
    ).then((results) => {
      // If any errors were returned from LocalAI abort the entire sequence because the embeddings
      // will be incomplete.
      const errors = results
        .filter((res) => !!res.error)
        .map((res) => res.error)
        .flat();
      if (errors.length > 0) {
        let uniqueErrors = new Set();
        errors.map((error) =>
          uniqueErrors.add(`[${error.type}]: ${error.message}`)
        );

        return {
          data: [],
          error: Array.from(uniqueErrors).join(", "),
        };
      }
      return {
        data: results.map((res) => res?.data || []).flat(),
        error: null,
      };
    });

    if (!!error) throw new Error(`LocalAI Failed to embed: ${error}`);
    return data.length > 0 &&
      data.every((embd) => embd.hasOwnProperty("embedding"))
      ? data.map((embd) => embd.embedding)
      : null;
  }
}

module.exports = {
  LocalAiEmbedder,
};
