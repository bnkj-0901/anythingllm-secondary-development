const { EmbedChats } = require("../models/embedChats");
const { EmbedConfig } = require("../models/embedConfig");
const { EventLogs } = require("../models/eventLogs");
const { reqBody, userFromSession } = require("../utils/http");
const { validEmbedConfigId } = require("../utils/middleware/embedMiddleware");
const {
  authenticate: validatedRequest,
  manager,
  tenantId,
} = require("../utils/middleware/externalIdentity");
const { fail } = require("../enterprise/auth");
const prisma = require("../utils/prisma");
async function publishedLibrary(req) {
  const libraryId = req.body.libraryId;
  if (
    typeof libraryId !== "string" ||
    !(await prisma.ep_library_grants.findFirst({
      where: { libraryId, tenantId: tenantId(req) },
    }))
  )
    throw fail(400, "Choose a public knowledge library from this enterprise");
  return libraryId;
}

function embedManagementEndpoints(app) {
  if (!app) return;

  app.get("/embeds", [validatedRequest, manager], async (request, response) => {
    try {
      const embeds = await EmbedConfig.whereWithLibrary(
        request.ep.identity === "platform"
          ? {}
          : { tenantId: request.ep.tenantId },
        null,
        {
          createdAt: "desc",
        }
      );
      response.status(200).json({ embeds });
    } catch (e) {
      console.error(e);
      response.status(e.status || 500).json({
        error: e.status ? e.message : "Unable to process embed request",
      });
    }
  });

  app.post(
    "/embeds/new",
    [validatedRequest, manager],
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const data = {
          ...reqBody(request),
          libraryId: await publishedLibrary(request),
        };
        const { embed, message: error } = await EmbedConfig.new(
          data,
          user?.id,
          tenantId(request)
        );
        if (!embed) return response.status(400).json({ embed, error });
        await EventLogs.logEvent(
          "embed_created",
          { embedId: embed.id },
          user?.id
        );
        response.status(200).json({ embed, error });
      } catch (e) {
        console.error(e);
        response.status(e.status || 500).json({
          error: e.status ? e.message : "Unable to process embed request",
        });
      }
    }
  );

  app.post(
    "/embed/update/:embedId",
    [validatedRequest, manager, validEmbedConfigId],
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const { embedId } = request.params;
        const updates = reqBody(request);
        if (updates.libraryId !== undefined) await publishedLibrary(request);
        const { success, error } = await EmbedConfig.update(embedId, updates);
        await EventLogs.logEvent("embed_updated", { embedId }, user?.id);
        response.status(200).json({ success, error });
      } catch (e) {
        console.error(e);
        response.status(e.status || 500).json({
          error: e.status ? e.message : "Unable to process embed request",
        });
      }
    }
  );

  app.delete(
    "/embed/:embedId",
    [validatedRequest, manager, validEmbedConfigId],
    async (request, response) => {
      try {
        const { embedId } = request.params;
        await EmbedConfig.delete({ id: Number(embedId) });
        await EventLogs.logEvent(
          "embed_deleted",
          { embedId },
          response?.locals?.user?.id
        );
        response.status(200).json({ success: true, error: null });
      } catch (e) {
        console.error(e);
        response.status(e.status || 500).json({
          error: e.status ? e.message : "Unable to process embed request",
        });
      }
    }
  );

  app.post(
    "/embed/chats",
    [validatedRequest, manager],
    async (request, response) => {
      try {
        const { offset = 0, limit = 20 } = reqBody(request);
        const embedChats = await EmbedChats.whereWithEmbedAndLibrary(
          request.ep.identity === "platform"
            ? {}
            : { embed_config: { tenantId: request.ep.tenantId } },
          limit,
          { id: "desc" },
          offset * limit
        );
        const totalChats = await EmbedChats.count(
          request.ep.identity === "platform"
            ? {}
            : { embed_config: { tenantId: request.ep.tenantId } }
        );
        const hasPages = totalChats > (offset + 1) * limit;
        response.status(200).json({ chats: embedChats, hasPages, totalChats });
      } catch (e) {
        console.error(e);
        response.status(e.status || 500).json({
          error: e.status ? e.message : "Unable to process embed request",
        });
      }
    }
  );

  app.delete(
    "/embed/chats/:chatId",
    [validatedRequest, manager],
    async (request, response) => {
      try {
        const { chatId } = request.params;
        await EmbedChats.delete({
          id: Number(chatId),
          ...(request.ep.identity === "platform"
            ? {}
            : { embed_config: { tenantId: request.ep.tenantId } }),
        });
        response.status(200).json({ success: true, error: null });
      } catch (e) {
        console.error(e);
        response.status(e.status || 500).json({
          error: e.status ? e.message : "Unable to process embed request",
        });
      }
    }
  );
}

module.exports = { embedManagementEndpoints };
