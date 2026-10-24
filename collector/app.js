const express = require("express");
const cors = require("cors");
const { ACCEPTED_MIMES } = require("./utils/constants");
const { parseDocument } = require("./documentParser");
const { CommunicationKey } = require("./utils/comKey");
const { verifySignedDocument } = require("./middleware/verifySignedDocument");
const { httpLogger } = require("./middleware/httpLogger");
const { reqBody } = require("./utils/http");
const { getLinkText } = require("./processLink");
const { convertAudioToWav } = require("./convertAudioToWav");
const { verifyPayloadIntegrity } = require("./middleware/verifyIntegrity");

function createCollectorApp(options = {}) {
  const app = express();
  app.disable("x-powered-by");
  if (
    process.env.NODE_ENV === "development" &&
    process.env.ENABLE_HTTP_LOGGER
  ) {
    app.use(
      httpLogger({
        enableTimestamps: !!process.env.ENABLE_HTTP_LOGGER_TIMESTAMPS,
      })
    );
  }
  app.use(cors({ origin: true }));
  // Preserve the original pure-tool routes and their raw-body signature contract.
  app.use(
    [
      "/util/get-link",
      "/util/convert-audio-to-wav",
      "/ext/import",
      /^\/ext\/(?:[^/]+-repo\/branches|website-depth|youtube-transcript)$/,
    ],
    express.text({ type: ["text/plain", "application/json"], limit: "3GB" })
  );

  const extractionTools = express.Router();
  require("./extensions")(extractionTools);
  app.use((req, res, next) =>
    /^\/ext\/[^/]+-repo\/branches$/.test(req.path)
      ? extractionTools(req, res, next)
      : next()
  );
  app.post("/ext/website-depth", verifyPayloadIntegrity, async (req, res) => {
    try {
      const { validURL, validateURL } = require("./utils/url");
      const { url, depth = 1, maxLinks = 20 } = reqBody(req);
      const target = validateURL(url);
      if (!validURL(target)) throw new Error("Not a valid URL.");
      const data = await require("./utils/extensions/WebsiteDepth")(
        target,
        depth,
        maxLinks,
        { returnDocuments: true }
      );
      res.json({ success: true, data });
    } catch (error) {
      res.status(400).json({ success: false, reason: error.message });
    }
  });
  app.post(
    "/ext/import",
    [
      verifyPayloadIntegrity,
      require("./middleware/setDataSigner").setDataSigner,
    ],
    async (req, res) => {
      try {
        const { connector, args = {} } = reqBody(req);
        res.locals.returnDocuments = true;
        let result;
        if (["github", "gitlab", "gitea"].includes(connector))
          result =
            await require("./utils/extensions/RepoLoader").resolveRepoLoaderFunction(
              connector
            )(args, res);
        else if (connector === "confluence")
          result =
            await require("./utils/extensions/Confluence").loadConfluence(
              args,
              res
            );
        else if (connector === "drupalwiki")
          result =
            await require("./utils/extensions/DrupalWiki").loadAndStoreSpaces(
              args,
              res
            );
        else if (connector === "obsidian")
          result =
            await require("./utils/extensions/ObsidianVault").loadObsidianVault(
              args,
              { returnDocuments: true }
            );
        else if (connector === "paperless-ngx")
          result =
            await require("./utils/extensions/PaperlessNgx").loadPaperlessNgx(
              args,
              res
            );
        else if (connector === "youtube-transcript") {
          result =
            await require("./utils/extensions/YoutubeTranscript").loadYouTubeTranscript(
              args,
              { parseOnly: true }
            );
          result.documents = result.content
            ? [
                {
                  pageContent: result.content,
                  title: args.url,
                  chunkSource: `youtube://${args.url}`,
                },
              ]
            : [];
        } else if (connector === "website-depth") {
          const { validURL, validateURL } = require("./utils/url");
          const url = validateURL(args.url);
          if (!validURL(url)) throw new Error("Not a valid URL.");
          const documents = await require("./utils/extensions/WebsiteDepth")(
            url,
            args.depth,
            args.maxLinks,
            { returnDocuments: true }
          );
          result = { success: true, documents };
        } else
          return res
            .status(400)
            .json({ success: false, reason: "Unsupported connector" });
        res.json(result);
      } catch {
        console.error("[collector] data connector import failed");
        res.status(422).json({
          success: false,
          reason: "Data connector could not extract documents",
          documents: [],
        });
      }
    }
  );
  app.post(
    "/ext/youtube-transcript",
    verifyPayloadIntegrity,
    async (req, res) => {
      try {
        const result =
          await require("./utils/extensions/YoutubeTranscript").loadYouTubeTranscript(
            reqBody(req),
            { parseOnly: true }
          );
        res.json(result);
      } catch (error) {
        res
          .status(400)
          .json({ success: false, reason: error.message, data: {} });
      }
    }
  );
  app.post(
    "/util/get-link",
    [verifyPayloadIntegrity],
    async function (request, response) {
      const { link, captureAs = "text", options = {} } = reqBody(request);
      try {
        const { success, content = null } = await getLinkText(
          link,
          captureAs,
          options
        );
        response.status(200).json({ url: link, success, content });
      } catch (e) {
        console.error(e);
        response.status(200).json({
          url: link,
          success: false,
          content: null,
        });
      }
      return;
    }
  );

  app.post(
    "/util/convert-audio-to-wav",
    [verifyPayloadIntegrity],
    async function (request, response) {
      const { filename } = reqBody(request);
      try {
        const {
          success,
          reason,
          wavFilename = null,
        } = await convertAudioToWav(filename);
        response.status(200).json({ filename, success, reason, wavFilename });
      } catch (e) {
        console.error(e);
        response.status(200).json({
          filename,
          success: false,
          reason: "An audio conversion error occurred.",
          wavFilename: null,
        });
      }
      return;
    }
  );

  // Original extraction options may include configured transcription credentials.
  // Signing authenticates requests; keep this internal service private.
  // Verify the exact bytes the server signed before interpreting the payload.
  app.use(
    express.json({
      limit: "3GB",
      verify(req, _res, buffer) {
        req.rawBody = buffer.toString("utf8");
      },
    })
  );
  const key = new CommunicationKey();
  const verifySignature =
    options.verifySignature ||
    ((signature, body) => key.verify(signature, body));
  const parser = options.parseDocument || parseDocument;

  app.get(["/", "/health"], (_req, res) =>
    res.json({ status: "ok", service: "document-parser" })
  );
  app.get("/accepts", (_req, res) => res.json(ACCEPTED_MIMES));
  app.post(
    "/parse",
    verifySignedDocument(verifySignature),
    async (req, res) => {
      try {
        const result = await parser(req.body);
        res.json({
          filename: req.body.filename,
          success: true,
          reason: null,
          documents: result,
        });
      } catch (error) {
        res.status(error.expose === true ? error.status : 422).json({
          success: false,
          reason:
            error.expose === true
              ? error.message
              : "无法提取文档正文，请检查文件或稍后重试",
          documents: [],
        });
      }
    }
  );
  // These original extraction engines return content to the authenticated
  // server; the server owns tenant storage, publication and approval.
  app.post(
    "/process-raw-text",
    verifySignedDocument(verifySignature),
    async (req, res, next) => {
      try {
        const result = await require("./processRawText").processRawText(
          req.body.textContent,
          req.body.metadata,
          { returnDocuments: true }
        );
        res.json(result);
      } catch (error) {
        next(error);
      }
    }
  );
  app.post(
    "/ext/resync-source-document",
    verifySignedDocument(verifySignature),
    async (req, res, next) => {
      try {
        const methods = require("./extensions/resync");
        const { type, options: syncOptions = {} } = req.body;
        if (!Object.hasOwn(methods, type))
          return res.status(400).json({
            success: false,
            content: null,
            reason: "不支持的同步来源",
          });
        if (!["link", "youtube"].includes(type)) {
          require("./middleware/setDataSigner").setDataSigner(
            req,
            res,
            () => {}
          );
        }
        await methods[type](syncOptions, res);
      } catch (error) {
        next(error);
      }
    }
  );
  app.use((_req, res) => res.status(404).json({ error: "接口不存在" }));
  app.use((error, _req, res, _next) => {
    res.status(error.type === "entity.too.large" ? 413 : 400).json({
      success: false,
      reason: "解析请求格式无效",
      documents: [],
    });
  });
  return app;
}

module.exports = { createCollectorApp };
