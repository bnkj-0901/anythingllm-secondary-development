const prisma = require("../utils/prisma");
const { safeJsonParse } = require("../utils/http");

const ExternalCommunicationConnector = {
  supportedTypes: ["telegram"],

  /**
   * Get a connector by type.
   * @param {'telegram'} type
   * @returns {Promise<{id: number, type: string, config: object, active: boolean}|null>}
   */
  get: async function (type, tenantId) {
    try {
      const connector =
        await prisma.external_communication_connectors.findUnique({
          where: { tenantId_type: { tenantId, type } },
        });
      if (!connector) return null;
      return {
        ...connector,
        config: safeJsonParse(connector.config, {}),
      };
    } catch (error) {
      console.error("ExternalCommunicationConnector.get", error.message);
      return null;
    }
  },

  /**
   * Create or update a connector's config and active state.
   * @param {'telegram'} type
   * @param {object} config
   * @param {boolean} active
   * @returns {Promise<{connector: object|null, error: string|null}>}
   */
  upsert: async function (type, config = {}, tenantId) {
    config = { ...config };
    if (!this.supportedTypes.includes(type))
      return { connector: null, error: `Unsupported connector type: ${type}` };

    try {
      let update = {},
        create = {};

      if (config.hasOwnProperty("active")) {
        update.active = Boolean(config.active);
        create.active = Boolean(config.active);
        delete config.active;
      }

      update = Object.assign(update, {
        config: JSON.stringify(config),
        botId: config.bot_id ? String(config.bot_id) : null,
        lastUpdatedAt: new Date(),
      });
      create = Object.assign(create, {
        config: JSON.stringify(config),
        type: String(type),
        tenantId,
        botId: config.bot_id ? String(config.bot_id) : null,
      });

      const connector = await prisma.$transaction(async (tx) => {
        const rows =
          await tx.$queryRaw`SELECT id FROM external_communication_connectors WHERE "tenantId"=${tenantId} AND type=${type} FOR UPDATE`;
        if (rows.length) {
          const current = await tx.external_communication_connectors.findUnique(
            { where: { id: rows[0].id } }
          );
          if (current.botId === update.botId) {
            const live = safeJsonParse(current.config, {});
            update.config = JSON.stringify({
              ...config,
              approved_users: live.approved_users || [],
              voice_response_mode:
                live.voice_response_mode || config.voice_response_mode,
            });
          }
        }
        return tx.external_communication_connectors.upsert({
          where: { tenantId_type: { tenantId, type: String(type) } },
          update,
          create,
        });
      });
      return {
        connector: {
          ...connector,
          config: safeJsonParse(connector.config, {}),
        },
        error: null,
      };
    } catch (error) {
      console.error("ExternalCommunicationConnector.upsert", error.message);
      return { connector: null, error: error.message };
    }
  },

  /**
   * Merge partial config updates into an existing connector.
   * @param {'telegram'} type
   * @param {object} configUpdates - Partial config to merge.
   * @returns {Promise<{connector: object|null, error: string|null}>}
   */
  updateConfig: async function (type, configUpdates = {}, tenantId) {
    return prisma.$transaction(async (tx) => {
      // Serialize partial updates so a late state save cannot restore a revoked
      // binding or overwrite a new Bot connection with stale configuration.
      const rows =
        await tx.$queryRaw`SELECT id FROM external_communication_connectors WHERE "tenantId"=${tenantId} AND type=${type} FOR UPDATE`;
      if (!rows.length)
        return { connector: null, error: `No ${type} connector found` };
      const current = await tx.external_communication_connectors.findUnique({
        where: { id: rows[0].id },
      });
      const config = safeJsonParse(current.config, {});
      const updates =
        typeof configUpdates === "function"
          ? await configUpdates(config)
          : configUpdates;
      const merged = { ...config, ...updates };
      const connector = await tx.external_communication_connectors.update({
        where: { id: current.id },
        data: { config: JSON.stringify(merged), lastUpdatedAt: new Date() },
      });
      return { connector: { ...connector, config: merged }, error: null };
    });
  },

  /**
   * Delete a connector entirely.
   * @param {'telegram'} type
   * @returns {Promise<boolean>}
   */
  delete: async function (type, tenantId) {
    try {
      await prisma.external_communication_connectors.delete({
        where: { tenantId_type: { tenantId, type } },
      });
      return true;
    } catch (error) {
      console.error("ExternalCommunicationConnector.delete", error.message);
      return false;
    }
  },
};

module.exports = { ExternalCommunicationConnector };
