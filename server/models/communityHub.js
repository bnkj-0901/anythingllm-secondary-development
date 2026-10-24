const ImportedPlugin = require("../utils/agents/imported");

/**
 * An interface to the AnythingLLM Community Hub external API.
 */
const CommunityHub = {
  importPrefix: "allm-community-id",
  apiBase:
    process.env.NODE_ENV === "development"
      ? "http://127.0.0.1:5001/anythingllm-hub/us-central1/external/v1"
      : "https://hub.external.anythingllm.com/v1",
  supportedStaticItemTypes: ["system-prompt", "agent-flow", "slash-command"],

  /**
   * Validate an import ID and return the entity type and ID.
   * @param {string} importId - The import ID to validate.
   * @returns {{entityType: string | null, entityId: string | null}}
   */
  validateImportId: function (importId) {
    if (
      !importId ||
      !importId.startsWith(this.importPrefix) ||
      importId.split(":").length !== 3
    )
      return { entityType: null, entityId: null };
    const [_, entityType, entityId] = importId.split(":");
    if (!entityType || !entityId) return { entityType: null, entityId: null };
    return {
      entityType: String(entityType).trim(),
      entityId: String(entityId).trim(),
    };
  },

  /**
   * Fetch the explore items from the community hub that are publicly available.
   * @returns {Promise<{agentSkills: {items: [], hasMore: boolean, totalCount: number}, systemPrompts: {items: [], hasMore: boolean, totalCount: number}, slashCommands: {items: [], hasMore: boolean, totalCount: number}}>}
   */
  fetchExploreItems: async function () {
    return await fetch(`${this.apiBase}/explore`, {
      method: "GET",
    })
      .then((response) => response.json())
      .catch((error) => {
        console.error("Error fetching explore items:", error);
        return {
          agentSkills: {
            items: [],
            hasMore: false,
            totalCount: 0,
          },
          systemPrompts: {
            items: [],
            hasMore: false,
            totalCount: 0,
          },
          slashCommands: {
            items: [],
            hasMore: false,
            totalCount: 0,
          },
        };
      });
  },

  /**
   * Fetch a bundle item from the community hub.
   * Bundle items are entities that require a downloadURL to be fetched from the community hub.
   * so we can unzip and import them to the AnythingLLM instance.
   * @param {string} importId - The import ID of the item.
   * @returns {Promise<{url: string | null, item: object | null, error: string | null}>}
   */
  getBundleItem: async function (importId) {
    const { entityType, entityId } = this.validateImportId(importId);
    if (!entityType || !entityId)
      return { item: null, error: "Invalid import ID" };

    const { SystemSettings } = require("./systemSettings");
    const { connectionKey } = await SystemSettings.hubSettings();
    const { url, item, error } = await fetch(
      `${this.apiBase}/${entityType}/${entityId}/pull`,
      {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          ...(connectionKey
            ? { Authorization: `Bearer ${connectionKey}` }
            : {}),
        },
      }
    )
      .then((response) => response.json())
      .catch((error) => {
        console.error(
          `Error fetching bundle item for import ID ${importId}:`,
          error
        );
        return { url: null, item: null, error: error.message };
      });
    return { url, item, error };
  },

  /**
   * Apply an item to the AnythingLLM instance. Used for simple items like slash commands and system prompts.
   * @param {object} item - The item to apply.
   * @param {object} options - Additional options for applying the item.
   * @param {object|null} options.currentUser - The current user object.
   * @returns {Promise<{success: boolean, error: string | null}>}
   */
  applyItem: async function (item, options = {}) {
    if (!item) return { success: false, error: "Item is required" };
    if (options.currentContext?.identity !== "platform")
      return {
        success: false,
        error: "Only the top administrator can import shared templates",
      };
    const store = require("../enterprise/store");
    const { assertManagerContext, context } = require("../enterprise/auth");

    if (item.itemType === "system-prompt") {
      if (typeof options.tenantId !== "string" || !options.tenantId)
        return {
          success: false,
          error: "Select a tenant for this system prompt",
        };
      const {
        getSettings,
        validateSettings,
      } = require("../enterprise/rag-settings");
      await store.transaction(
        async (tx) => {
          await assertManagerContext(options.currentContext, tx);
          if (
            !(await tx.one(
              "SELECT id FROM ep_tenants WHERE id=$1",
              options.tenantId
            ))
          )
            throw new Error("Tenant not found");
          const current = await getSettings(options.tenantId, tx);
          const settings = validateSettings(
            { openAiPrompt: item.prompt },
            current
          );
          if (
            current.openAiPrompt &&
            current.openAiPrompt !== settings.openAiPrompt
          )
            await tx.orm.prompt_history.create({
              data: {
                tenantId: options.tenantId,
                prompt: current.openAiPrompt,
                modifiedBy: options.currentContext.userId,
              },
            });
          await tx.run(
            'INSERT INTO ep_rag_settings("tenantId",settings,"updatedAt") VALUES($1,$2,$3) ON CONFLICT("tenantId") DO UPDATE SET settings=excluded.settings,"updatedAt"=excluded."updatedAt"',
            options.tenantId,
            JSON.stringify(settings),
            store.now()
          );
        },
        { retry: true }
      );
      return { success: true, error: null };
    }

    if (item.itemType === "slash-command") {
      const { SlashCommandPresets } = require("./slashCommandsPresets");
      const { isReservedCommand } = require("../utils/chats");
      const command = SlashCommandPresets.formatCommand(String(item.command));
      if (isReservedCommand(command))
        return {
          success: false,
          error:
            "Cannot import a preset with a command that matches a system command",
        };

      if (
        typeof options.tenantId !== "string" ||
        !Number.isInteger(options.userId) ||
        !options.tenantId ||
        !options.userId
      )
        return {
          success: false,
          error: "Select a tenant user for this slash command",
        };
      await store.transaction(
        async (tx) => {
          await assertManagerContext(options.currentContext, tx);
          const user = await context(options.userId, tx);
          if (user.tenantId !== options.tenantId)
            throw new Error("User does not belong to the selected tenant");
          await SlashCommandPresets.create(
            user,
            {
              command,
              prompt: String(item.prompt),
              description: String(item.description),
            },
            tx.orm
          );
        },
        { retry: true }
      );
      return { success: true, error: null };
    }

    return {
      success: false,
      error: "Unsupported item type. Nothing to apply.",
    };
  },

  /**
   * Import a bundle item to the AnythingLLM instance by downloading the zip file and importing it.
   * or whatever the item type requires.
   * @param {{url: string, item: object}} params
   * @returns {Promise<{success: boolean, error: string | null}>}
   */
  importBundleItem: async function ({ url, item }) {
    if (item.itemType === "agent-skill") {
      const { success, error } =
        await ImportedPlugin.importCommunityItemFromUrl(url, item);
      return { success, error };
    }

    return {
      success: false,
      error: "Unsupported item type. Nothing to import.",
    };
  },

  fetchUserItems: async function (connectionKey) {
    if (!connectionKey) return { createdByMe: {}, teamItems: [] };

    return await fetch(`${this.apiBase}/items`, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${connectionKey}`,
      },
    })
      .then((response) => response.json())
      .catch((error) => {
        console.error("Error fetching user items:", error);
        return { createdByMe: {}, teamItems: [] };
      });
  },

  /**
   * Create a new item in the community hub - Only supports STATIC items for now.
   * @param {string} itemType - The type of item to create
   * @param {object} data - The item data
   * @param {string} connectionKey - The hub connection key
   * @returns {Promise<{success: boolean, error: string | null}>}
   */
  createStaticItem: async function (itemType, data, connectionKey) {
    if (!connectionKey)
      return { success: false, error: "Connection key is required" };
    if (!this.supportedStaticItemTypes.includes(itemType))
      return { success: false, error: "Unsupported item type" };

    // If the item has special considerations or preprocessing, we can delegate that below before sending the request.
    // eg: Agent flow files and such.

    return await fetch(`${this.apiBase}/${itemType}/create`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${connectionKey}`,
      },
      body: JSON.stringify(data),
    })
      .then((response) => response.json())
      .then((result) => {
        if (!!result.error) throw new Error(result.error || "Unknown error");
        return { success: true, error: null, itemId: result.item.id };
      })
      .catch((error) => {
        console.error(`Error creating ${itemType}:`, error);
        return { success: false, error: error.message };
      });
  },
};

module.exports = { CommunityHub };
