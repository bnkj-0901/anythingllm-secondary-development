const { reqBody } = require("../utils/http");
const { validatedRequest } = require("../utils/middleware/validatedRequest");
const { pushNotificationService } = require("../utils/PushNotifications");
const { wrap } = require("../utils/middleware/externalIdentity");

function webPushEndpoints(app) {
  if (!app) return;

  app.post(
    "/web-push/subscribe",
    [validatedRequest],
    wrap(async (request, response) => {
      const subscription = reqBody(request);
      await pushNotificationService.registerSubscription(
        request.ep,
        subscription
      );
      response.status(201).json({});
    })
  );

  app.get("/web-push/pubkey", [validatedRequest], (_request, response) => {
    const publicKey = pushNotificationService.publicVapidKey;
    response.status(200).json({ publicKey });
  });
}

module.exports = { webPushEndpoints };
