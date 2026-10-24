const {
  userFromSession,
  safeJsonParse,
} = require("../utils/http");
const { validatedRequest } = require("../utils/middleware/validatedRequest");
const {
  flexUserRoleValid,
  ROLES,
} = require("../utils/middleware/multiUserProtected");
const createFilesLib = require("../utils/agents/aibitat/plugins/create-files/lib");
const { Telemetry } = require("../models/telemetry");

/**
 * Endpoints for serving agent-generated files (PPTX, etc.) with authentication
 * and ownership validation.
 */
function agentFileServerEndpoints(app) {
  if (!app) return;

  /**
   * Download a generated file by its storage filename.
   * Validates that the requesting user has access to the workspace
   * where the file was generated.
   */
  app.get(
    "/agent-skills/generated-files/:filename",
    [validatedRequest, flexUserRoleValid([ROLES.all])],
    async (request, response) => {
      try {
        await userFromSession(request, response);
        const { filename } = request.params;
        if (!filename)
          return response.status(400).json({ error: "Filename is required" });

        // Validate filename format
        const parsed = createFilesLib.parseFilename(filename);
        if (!parsed) {
          return response
            .status(400)
            .json({ error: "Invalid filename format" });
        }

        // Find a chat or scheduled job run that references this file
        const fileSource = await findFileSource(filename, request.ep);

        if (!fileSource) {
          return response.status(404).json({
            error: "File not found or access denied",
          });
        }

        // Retrieve the file from storage
        const fileData = await createFilesLib.getGeneratedFile(filename);
        if (!fileData) {
          return response
            .status(404)
            .json({ error: "File not found in storage" });
        }

        // Get mime type and set headers for download
        const mimeType = createFilesLib.getMimeType(`.${parsed.extension}`);
        const safeFilename = createFilesLib.sanitizeFilenameForHeader(
          fileSource.displayFilename || filename
        );
        response.setHeader("Content-Type", mimeType);
        response.setHeader(
          "Content-Disposition",
          `attachment; filename="${safeFilename}"`
        );
        response.setHeader("Content-Length", fileData.buffer.length);
        response.send(fileData.buffer);
        Telemetry.sendTelemetry("agent_generated_file_downloaded", {
          type: mimeType,
        }).catch(() => {});
        return;
      } catch (error) {
        console.error("[agentFileServer] Download error:", error.message);
        return response.status(500).json({ error: "Failed to download file" });
      }
    }
  );

  /**
   * Serve a generated image inline (so it can be used as an <img> src).
   * Validates that the requesting user has access to a chat that references
   * the image before serving it from storage/generated-images.
   */
  app.get(
    "/image-generation/generated-images/:filename",
    [validatedRequest, flexUserRoleValid([ROLES.all])],
    async (request, response) => {
      try {
        const fs = require("fs");
        const path = require("path");
        const {
          generatedImagesPath,
          GENERATED_IMAGE_FILENAME_PATTERN,
        } = require("../utils/files");
        await userFromSession(request, response);
        const { filename } = request.params;

        if (!filename || !GENERATED_IMAGE_FILENAME_PATTERN.test(filename))
          return response.status(400).json({ error: "Invalid filename" });

        const fileSource = await findFileSource(filename, request.ep);
        if (!fileSource)
          return response
            .status(404)
            .json({ error: "Image not found or access denied" });

        const imagePath = path.resolve(generatedImagesPath, filename);
        let imageBuffer;
        try {
          imageBuffer = await fs.promises.readFile(imagePath);
        } catch {
          return response
            .status(404)
            .json({ error: "Image not found in storage" });
        }

        response.setHeader("Content-Type", "image/png");
        return response.send(imageBuffer);
      } catch (error) {
        console.error("[agentFileServer] Image serve error:", error.message);
        return response.status(500).json({ error: "Failed to serve image" });
      }
    }
  );
}

/**
 * Locates the source record (a workspace chat or a scheduled job run) that
 * references the given storage filename, and confirms the requester has access.
 *
 * Search order:
 *   1. Workspace chats the user can access (per multi-user permissions).
 *   2. Scheduled job runs — single-user only, so no per-user access check.
 *
 * @param {string} storageFilename
 * @param {{ user: object|null, isMultiUser: boolean }} ctx
 * @returns {Promise<{workspaceId: number|null, displayFilename: string}|null>}
 */
async function findFileSource(storageFilename, ctx, db = require("../enterprise/store").orm) {
  if (!ctx) return null;
  const scope = ctx.identity === "platform" ? {} : require("../models/workspaceChats").chatScope(ctx);
  const chats = await db.chats.findMany({where: {...scope, response: {contains: storageFilename}}});
  for (const chat of chats) {
    const {outputs = [], text} = safeJsonParse(chat.response, {});
    if (!chat.include && !!text) continue;
    const output = outputs.find((item) => item?.payload?.storageFilename === storageFilename);
    if (output) return {conversationId:chat.thread_id, displayFilename:output.payload.filename || output.payload.displayFilename};
  }
  const runs = await db.scheduled_job_runs.findMany({
    where: {status:"completed", result:{contains:storageFilename}, ...(ctx.identity === "platform" ? {} : {job:scope})},
  });
  for (const run of runs) {
    const {outputs = []} = safeJsonParse(run.result, {});
    const output = outputs.find((item) => item?.payload?.storageFilename === storageFilename);
    if (output) return {displayFilename:output.payload.filename || storageFilename};
  }
  return null;
}
async function validateGeneratedImageAccess(attachments, ctx, db) {
  if (!Array.isArray(attachments)) throw Object.assign(new Error("Invalid attachments"), {status:400});
  for (const attachment of attachments)
    if (attachment?.storageFilename && !await findFileSource(attachment.storageFilename, ctx, db))
      throw Object.assign(new Error("Image not found or access denied"), {status:404});
}
module.exports = { agentFileServerEndpoints, findFileSource, validateGeneratedImageAccess };
