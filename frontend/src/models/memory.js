import { API_BASE } from "@/utils/constants";
import { baseHeaders } from "@/utils/request";

/**
 * @typedef {Object} Memory
 * @property {number} id
 * @property {number|null} userId
 * @property {number|null} workspaceId
 * @property {"workspace"|"global"} scope
 * @property {string} content
 * @property {string|null} lastUsedAt
 * @property {string} createdAt
 * @property {string} updatedAt
 */

const Memory = {
  /**
   * Fetch all memories (global + workspace) for a workspace.
   * @param {string} slug
   * @returns {Promise<{global: Memory[], workspace: Memory[]}>}
   */
  forUser: async function () {
    const response = await fetch(`${API_BASE}/memories`, {
      headers: baseHeaders(),
    });
    if (!response.ok) throw new Error("Unable to load memories");
    return (await response.json()).memories || [];
  },

  /**
   * Create a new memory for a workspace.
   * @param {string} slug
   * @param {{content: string, scope?: "workspace"|"global"}} body
   * @returns {Promise<{memory: Memory|null, error?: string}>}
   */
  create: async function ({ content }) {
    return await fetch(`${API_BASE}/memories`, {
      method: "POST",
      headers: baseHeaders(),
      body: JSON.stringify({ content }),
    })
      .then((res) => res.json())
      .catch((e) => ({ memory: null, error: e.message }));
  },

  /**
   * Update an existing memory's content.
   * @param {number} memoryId
   * @param {{content: string}} body
   * @returns {Promise<{memory: Memory|null, error?: string}>}
   */
  update: async function (memoryId, { content }) {
    return await fetch(`${API_BASE}/memories/${memoryId}`, {
      method: "PUT",
      headers: baseHeaders(),
      body: JSON.stringify({ content }),
    })
      .then((res) => res.json())
      .catch((e) => ({ memory: null, error: e.message }));
  },

  /**
   * Delete a memory.
   * @param {number} memoryId
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  delete: async function (memoryId) {
    return await fetch(`${API_BASE}/memories/${memoryId}`, {
      method: "DELETE",
      headers: baseHeaders(),
    })
      .then((res) => res.json())
      .catch((e) => ({ success: false, error: e.message }));
  },
};

export default Memory;
