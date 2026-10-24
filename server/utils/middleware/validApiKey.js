const { ApiKey } = require("../../models/apiKeys");
const { bindIdentity, wrap } = require("./externalIdentity");
const validApiKey = wrap(async (req, res, next) => {
  const secret = (req.headers.authorization || "").replace(/^Bearer /i, "");
  const key = secret ? await ApiKey.get({ secret }) : null;
  await bindIdentity(req, res, key, key?.userId);
  res.locals.apiKey = key;
  next();
});
module.exports = { validApiKey };
