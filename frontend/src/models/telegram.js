import { API_BASE } from "@/utils/constants";
import { baseHeaders } from "@/utils/request";

let targetTenantId = "";
const endpoint = (path) =>
  `${API_BASE}/telegram/${path}${targetTenantId ? `?tenantId=${encodeURIComponent(targetTenantId)}` : ""}`;

const Telegram = {
  selectTenant: (id) => {
    targetTenantId = id || "";
  },
  /**
   * Get the current Telegram bot configuration.
   * @returns {Promise<{config: object|null, error: string|null}>}
   */
  getConfig: async function () {
    return await fetch(endpoint("config"), {
      headers: baseHeaders(),
    })
      .then((res) => res.json())
      .catch((e) => {
        console.error(e);
        return { config: null, error: e.message };
      });
  },

  /**
   * Connect and start the Telegram bot with given token and workspace.
   * @param {string} botToken - The bot API token from BotFather.
   * @param {string} workspaceSlug - The default workspace slug.
   * @returns {Promise<{success: boolean, bot_username: string|null, error: string|null}>}
   */
  connect: async function (botToken) {
    return await fetch(endpoint("connect"), {
      method: "POST",
      headers: baseHeaders(),
      body: JSON.stringify({
        bot_token: botToken,
      }),
    })
      .then((res) => res.json())
      .catch((e) => {
        console.error(e);
        return { success: false, error: e.message };
      });
  },

  /**
   * Disconnect and stop the Telegram bot.
   * @returns {Promise<{success: boolean, error: string|null}>}
   */
  disconnect: async function () {
    return await fetch(endpoint("disconnect"), {
      method: "POST",
      headers: baseHeaders(),
    })
      .then((res) => res.json())
      .catch((e) => {
        console.error(e);
        return { success: false, error: e.message };
      });
  },

  /**
   * Get the current bot connection status.
   * @returns {Promise<{active: boolean, bot_username: string|null}>}
   */
  status: async function () {
    return await fetch(endpoint("status"), {
      headers: baseHeaders(),
    })
      .then((res) => res.json())
      .catch((e) => {
        console.error(e);
        return { active: false, bot_username: null };
      });
  },

  /**
   * Get pending pairing requests.
   * @returns {Promise<{users: Array}>}
   */
  getPendingUsers: async function () {
    return await fetch(endpoint("pending-users"), {
      headers: baseHeaders(),
    })
      .then((res) => res.json())
      .catch((e) => {
        console.error(e);
        return { users: [] };
      });
  },

  /**
   * Get approved users list.
   * @returns {Promise<{users: Array}>}
   */
  getApprovedUsers: async function () {
    return await fetch(endpoint("approved-users"), {
      headers: baseHeaders(),
    })
      .then((res) => res.json())
      .catch((e) => {
        console.error(e);
        return { users: [] };
      });
  },

  /**
   * Approve a pending user.
   * @param {string} chatId
   * @returns {Promise<{success: boolean, error: string|null}>}
   */
  approveUser: async function (chatId, code) {
    return await fetch(endpoint("approve-user"), {
      method: "POST",
      headers: baseHeaders(),
      body: JSON.stringify({ chatId, code }),
    })
      .then((res) => res.json())
      .catch((e) => {
        console.error(e);
        return { success: false, error: e.message };
      });
  },

  /**
   * Deny a pending user.
   * @param {string} chatId
   * @returns {Promise<{success: boolean, error: string|null}>}
   */
  denyUser: async function (chatId) {
    return await fetch(endpoint("deny-user"), {
      method: "POST",
      headers: baseHeaders(),
      body: JSON.stringify({ chatId }),
    })
      .then((res) => res.json())
      .catch((e) => {
        console.error(e);
        return { success: false, error: e.message };
      });
  },

  /**
   * Update the Telegram bot configuration.
   * @param {object} updates - Config fields to update (e.g. voice_response_mode).
   * @returns {Promise<{success: boolean, error: string|null}>}
   */
  updateConfig: async function (updates) {
    return await fetch(endpoint("update-config"), {
      method: "POST",
      headers: baseHeaders(),
      body: JSON.stringify(updates),
    })
      .then((res) => res.json())
      .catch((e) => {
        console.error(e);
        return { success: false, error: e.message };
      });
  },

  /**
   * Revoke an approved user.
   * @param {string} chatId
   * @returns {Promise<{success: boolean, error: string|null}>}
   */
  revokeUser: async function (chatId) {
    return await fetch(endpoint("revoke-user"), {
      method: "POST",
      headers: baseHeaders(),
      body: JSON.stringify({ chatId }),
    })
      .then((res) => res.json())
      .catch((e) => {
        console.error(e);
        return { success: false, error: e.message };
      });
  },
};

export default Telegram;
