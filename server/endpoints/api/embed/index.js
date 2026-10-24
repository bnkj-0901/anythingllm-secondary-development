const { EmbedConfig } = require("../../../models/embedConfig");
const { EmbedChats } = require("../../../models/embedChats");
const { validApiKey } = require("../../../utils/middleware/validApiKey");
const { reqBody } = require("../../../utils/http");
const prisma = require("../../../utils/prisma");
const { manager } = require("../../../utils/middleware/externalIdentity");

function apiEmbedEndpoints(app) {
  if (!app) return;

  app.get("/v1/embed", [validApiKey, manager], async (request, response) => {
    /*
      #swagger.tags = ['Embed']
      #swagger.description = 'List all active embeds'
      #swagger.responses[200] = {
        content: {
          "application/json": {
            schema: {
              type: 'object',
              example: {
                embeds: [
                  {
                    "id": 1,
                    "uuid": "embed-uuid-1",
                    "enabled": true,
                    "chat_mode": "query",
                    "createdAt": "2023-04-01T12:00:00Z",
                    "library": {
                      "id": 1,
                      "name": "Published knowledge"
                    },
                    "chat_count": 10
                  },
                  {
                    "id": 2,
                    "uuid": "embed-uuid-2",
                    "enabled": false,
                    "chat_mode": "chat",
                    "createdAt": "2023-04-02T14:30:00Z",
                    "library": {
                      "id": 1,
                      "name": "Published knowledge"
                    },
                    "chat_count": 10
                  }
                ]
              }
            }
          }
        }
      }
      #swagger.responses[403] = {
        schema: {
          "$ref": "#/definitions/InvalidAPIKey"
        }
      }
    */
    try {
      const embeds = await EmbedConfig.whereWithLibrary({
        tenantId: request.ep.tenantId,
      });
      const filteredEmbeds = embeds.map((embed) => ({
        id: embed.id,
        uuid: embed.uuid,
        enabled: embed.enabled,
        chat_mode: embed.chat_mode,
        createdAt: embed.createdAt,
        library: embed.library,
        chat_count: embed._count.embed_chats,
      }));
      response.status(200).json({ embeds: filteredEmbeds });
    } catch (e) {
      console.error(e.message, e);
      response.sendStatus(500).end();
    }
  });

  app.get(
    "/v1/embed/:embedUuid/chats",
    [validApiKey, manager],
    async (request, response) => {
      /*
      #swagger.tags = ['Embed']
      #swagger.description = 'Get all chats for a specific embed'
      #swagger.parameters['embedUuid'] = {
        in: 'path',
        description: 'UUID of the embed',
        required: true,
        type: 'string'
      }
      #swagger.responses[200] = {
        content: {
          "application/json": {
            schema: {
              type: 'object',
              example: {
                chats: [
                  {
                    "id": 1,
                    "session_id": "session-uuid-1",
                    "prompt": "Hello",
                    "response": "Hi there!",
                    "createdAt": "2023-04-01T12:00:00Z"
                  },
                  {
                    "id": 2,
                    "session_id": "session-uuid-2",
                    "prompt": "How are you?",
                    "response": "I'm doing well, thank you!",
                    "createdAt": "2023-04-02T14:30:00Z"
                  }
                ]
              }
            }
          }
        }
      }
      #swagger.responses[403] = {
        schema: {
          "$ref": "#/definitions/InvalidAPIKey"
        }
      }
      #swagger.responses[404] = {
        description: "Embed not found",
      }
    */
      try {
        const { embedUuid } = request.params;
        const chats = await EmbedChats.where({
          embed_config: {
            uuid: String(embedUuid),
            tenantId: request.ep.tenantId,
          },
        });
        response.status(200).json({ chats });
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  app.get(
    "/v1/embed/:embedUuid/chats/:sessionUuid",
    [validApiKey, manager],
    async (request, response) => {
      /*
      #swagger.tags = ['Embed']
      #swagger.description = 'Get chats for a specific embed and session'
      #swagger.parameters['embedUuid'] = {
        in: 'path',
        description: 'UUID of the embed',
        required: true,
        type: 'string'
      }
      #swagger.parameters['sessionUuid'] = {
        in: 'path',
        description: 'UUID of the session',
        required: true,
        type: 'string'
      }
      #swagger.responses[200] = {
        content: {
          "application/json": {
            schema: {
              type: 'object',
              example: {
                chats: [
                  {
                    "id": 1,
                    "prompt": "Hello",
                    "response": "Hi there!",
                    "createdAt": "2023-04-01T12:00:00Z"
                  }
                ]
              }
            }
          }
        }
      }
      #swagger.responses[403] = {
        schema: {
          "$ref": "#/definitions/InvalidAPIKey"
        }
      }
      #swagger.responses[404] = {
        description: "Embed or session not found",
      }
    */
      try {
        const { embedUuid, sessionUuid } = request.params;
        const chats = await EmbedChats.where({
          embed_config: {
            uuid: String(embedUuid),
            tenantId: request.ep.tenantId,
          },
          session_id: String(sessionUuid),
        });
        response.status(200).json({ chats });
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  app.post(
    "/v1/embed/new",
    [validApiKey, manager],
    async (request, response) => {
      /*
      #swagger.tags = ['Embed']
      #swagger.description = 'Create a new embed configuration'
      #swagger.requestBody = {
        description: 'JSON object containing embed configuration details',
        required: true,
        content: {
          "application/json": {
            schema: {
              type: 'object',
              example: {
                "libraryId": "public-library-id",
                "chat_mode": "chat",
                "allowlist_domains": ["example.com"],
                "allow_model_override": false,
                "allow_temperature_override": false,
                "allow_prompt_override": false,
                "max_chats_per_day": 100,
                "max_chats_per_session": 10
              }
            }
          }
        }
      }
      #swagger.responses[200] = {
        content: {
          "application/json": {
            schema: {
              type: 'object',
              example: {
                "embed": {
                  "id": 1,
                  "uuid": "embed-uuid-1",
                  "enabled": true,
                  "chat_mode": "chat",
                  "allowlist_domains": ["example.com"],
                  "allow_model_override": false,
                  "allow_temperature_override": false,
                  "allow_prompt_override": false,
                  "max_chats_per_day": 100,
                  "max_chats_per_session": 10,
                  "createdAt": "2023-04-01T12:00:00Z",
                  "libraryId": "public-library-id"
                },
                "error": null
              }
            }
          }
        }
      }
      #swagger.responses[403] = {
        schema: {
          "$ref": "#/definitions/InvalidAPIKey"
        }
      }
      #swagger.responses[404] = {
        description: "Public knowledge library not found"
      }
    */
      try {
        const data = reqBody(request);

        if (
          typeof data.libraryId !== "string" ||
          !(await prisma.ep_library_grants.findFirst({
            where: { libraryId: data.libraryId, tenantId: request.ep.tenantId },
          }))
        )
          return response
            .status(400)
            .json({ error: "Choose an enterprise public library to publish" });
        const { embed, message: error } = await EmbedConfig.new(
          data,
          request.ep.userId,
          request.ep.tenantId
        );

        response.status(200).json({ embed, error });
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  app.post(
    "/v1/embed/:embedUuid",
    [validApiKey, manager],
    async (request, response) => {
      /*
      #swagger.tags = ['Embed']
      #swagger.description = 'Update an existing embed configuration'
      #swagger.parameters['embedUuid'] = {
        in: 'path',
        description: 'UUID of the embed to update',
        required: true,
        type: 'string'
      }
      #swagger.requestBody = {
        description: 'JSON object containing embed configuration updates',
        required: true,
        content: {
          "application/json": {
            schema: {
              type: 'object',
              example: {
                "enabled": true,
                "chat_mode": "chat",
                "allowlist_domains": ["example.com"],
                "allow_model_override": false,
                "allow_temperature_override": false,
                "allow_prompt_override": false,
                "max_chats_per_day": 100,
                "max_chats_per_session": 10
              }
            }
          }
        }
      }
      #swagger.responses[200] = {
        content: {
          "application/json": {
            schema: {
              type: 'object',
              example: {
                "success": true,
                "error": null
              }
            }
          }
        }
      }
      #swagger.responses[403] = {
        schema: {
          "$ref": "#/definitions/InvalidAPIKey"
        }
      }
      #swagger.responses[404] = {
        description: "Embed not found"
      }
    */
      try {
        const { embedUuid } = request.params;
        const data = reqBody(request);

        const embed = await EmbedConfig.get({
          uuid: String(embedUuid),
          tenantId: request.ep.tenantId,
        });
        if (!embed) {
          return response.status(404).json({ error: "Embed not found" });
        }

        if (
          data.libraryId !== undefined &&
          !(await prisma.ep_library_grants.findFirst({
            where: { libraryId: data.libraryId, tenantId: request.ep.tenantId },
          }))
        )
          return response
            .status(400)
            .json({ error: "Choose an enterprise public library to publish" });
        const { success, error } = await EmbedConfig.update(embed.id, data);
        response.status(200).json({ success, error });
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  app.delete(
    "/v1/embed/:embedUuid",
    [validApiKey, manager],
    async (request, response) => {
      /*
      #swagger.tags = ['Embed']
      #swagger.description = 'Delete an existing embed configuration'
      #swagger.parameters['embedUuid'] = {
        in: 'path',
        description: 'UUID of the embed to delete',
        required: true,
        type: 'string'
      }
      #swagger.responses[200] = {
        content: {
          "application/json": {
            schema: {
              type: 'object',
              example: {
                "success": true,
                "error": null
              }
            }
          }
        }
      }
      #swagger.responses[403] = {
        schema: {
          "$ref": "#/definitions/InvalidAPIKey"
        }
      }
      #swagger.responses[404] = {
        description: "Embed not found"
      }
    */
      try {
        const { embedUuid } = request.params;
        const embed = await EmbedConfig.get({
          uuid: String(embedUuid),
          tenantId: request.ep.tenantId,
        });
        if (!embed)
          return response.status(404).json({ error: "Embed not found" });
        const success = await EmbedConfig.delete({ id: embed.id });
        response
          .status(200)
          .json({ success, error: success ? null : "Failed to delete embed" });
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );
}

module.exports = { apiEmbedEndpoints };
