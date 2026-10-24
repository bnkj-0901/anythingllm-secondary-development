const {
  BrowserExtensionApiKey,
} = require("../../models/browserExtensionApiKey");
const { bindIdentity, wrap } = require("./externalIdentity");
const validBrowserExtensionApiKey = wrap(async (req, res, next) => {
  const secret = (req.headers.authorization || "").replace(/^Bearer /i, "");
  const key = secret.startsWith("brx-")
    ? await BrowserExtensionApiKey.validate(secret)
    : null;
  await bindIdentity(req, res, key, key?.user_id);
  res.locals.apiKey = key;
  next();
});
module.exports = { validBrowserExtensionApiKey };
