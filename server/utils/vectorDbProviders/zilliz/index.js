const { env } = require("../../../enterprise/ai/connection-context");
const { MilvusClient } = require("@zilliz/milvus2-sdk-node");
const { Milvus } = require("../milvus");

/**
 * Zilliz is the cloud version of Milvus so we can just extend the
 * Milvus class and override the connect method
 */
class Zilliz extends Milvus {
  constructor() {
    super();
  }

  get name() {
    return "Zilliz";
  }

  async connect() {
    if (env.VECTOR_DB !== "zilliz")
      throw new Error(`${this.name}::Invalid ENV settings`);

    const client = new MilvusClient({
      address: env.ZILLIZ_ENDPOINT,
      token: env.ZILLIZ_API_TOKEN,
    });

    const { isHealthy } = await client.checkHealth();
    if (!isHealthy)
      throw new Error(
        `${this.name}::Invalid Heartbeat received - is the instance online?`
      );

    return { client };
  }
}

module.exports.Zilliz = Zilliz;
