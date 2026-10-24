const { MobileDevice } = require("../../../models/mobileDevice");
const {
  bindIdentity,
  wrap,
} = require("../../../utils/middleware/externalIdentity");
const { fail } = require("../../../enterprise/auth");
const validDeviceToken = wrap(async (req, res, next) => {
  const token = req.header("x-anythingllm-mobile-device-token");
  const device = token
    ? await MobileDevice.get({ token: String(token) })
    : null;
  if (!device?.approved) throw fail(403, "Device not approved");
  await bindIdentity(req, res, device, device.userId);
  res.locals.device = device;
  next();
});
const validRegistrationToken = wrap(async (req, res, next) => {
  const token = (req.headers.authorization || "").replace(/^Bearer /i, "");
  const record = MobileDevice.tempToken(token);
  await bindIdentity(req, res, record, record?.userId);
  next();
});
module.exports = { validDeviceToken, validRegistrationToken };
