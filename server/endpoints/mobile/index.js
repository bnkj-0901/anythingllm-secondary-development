const {
  authenticate: validatedRequest,
  tenantId,
} = require("../../utils/middleware/externalIdentity");
const { MobileDevice } = require("../../models/mobileDevice");
const { handleMobileCommand } = require("./utils");
const { validDeviceToken, validRegistrationToken } = require("./middleware");
const { reqBody } = require("../../utils/http");
function deviceScope(request) {
  if (request.ep.identity === "platform")
    return request.query.tenantId ? { tenantId: tenantId(request) } : {};
  return {
    tenantId: request.ep.tenantId,
    ...(request.ep.role === "admin" ? {} : { userId: request.ep.userId }),
  };
}

function mobileEndpoints(app) {
  if (!app) return;

  /**
   * Gets all the devices from the database.
   * @param {import("express").Request} request
   * @param {import("express").Response} response
   */
  app.get("/mobile/devices", [validatedRequest], async (request, response) => {
    try {
      const devices = await MobileDevice.where(
        deviceScope(request),
        null,
        null,
        {
          user: { select: { id: true, username: true } },
        }
      );
      return response.status(200).json({ devices });
    } catch (e) {
      console.error(e);
      response.sendStatus(500).end();
    }
  });

  /**
   * Updates the device status via an updates object.
   * @param {import("express").Request} request
   * @param {import("express").Response} response
   */
  app.post(
    "/mobile/update/:id",
    [validatedRequest],
    async (request, response) => {
      try {
        const body = reqBody(request);
        const device = await MobileDevice.get({
          id: Number(request.params.id),
          ...deviceScope(request),
        });
        if (!device)
          return response.status(404).json({ error: "Device not found" });
        const updates = await MobileDevice.update(
          Number(request.params.id),
          body
        );
        if (updates.error)
          return response.status(400).json({ error: updates.error });
        return response.status(200).json({ updates });
      } catch (e) {
        console.error(e);
        response.sendStatus(500).end();
      }
    }
  );

  /**
   * Deletes a device from the database.
   * @param {import("express").Request} request
   * @param {import("express").Response} response
   */
  app.delete("/mobile/:id", [validatedRequest], async (request, response) => {
    try {
      const device = await MobileDevice.get({
        id: Number(request.params.id),
        ...deviceScope(request),
      });
      if (!device)
        return response.status(404).json({ error: "Device not found" });
      await MobileDevice.delete(device.id);
      return response.status(200).json({ message: "Device deleted" });
    } catch (e) {
      console.error(e);
      response.sendStatus(500).end();
    }
  });

  app.get(
    "/mobile/connect-info",
    [validatedRequest],
    async (request, response) => {
      try {
        if (request.ep.identity !== "tenant")
          return response
            .status(400)
            .json({ error: "Use a tenant user to pair a device" });
        return response.status(200).json({
          connectionUrl: MobileDevice.connectionURL(
            response.locals?.user,
            `${request.protocol}://${request.get("host")}`
          ),
        });
      } catch (e) {
        console.error(e);
        response.sendStatus(500).end();
      }
    }
  );

  /**
   * Checks if the device auth token is valid
   * against approved devices.
   */
  app.get("/mobile/auth", [validDeviceToken], async (_, response) => {
    try {
      return response
        .status(200)
        .json({ success: true, message: "Device authenticated" });
    } catch (e) {
      console.error(e);
      response.sendStatus(500).end();
    }
  });

  /**
   * Registers a new device (is open so that the mobile app can register itself)
   * Will create a new device in the database but requires approval by the user
   * before it can be used.
   * @param {import("express").Request} request
   * @param {import("express").Response} response
   */
  app.post(
    "/mobile/register",
    [validRegistrationToken],
    async (request, response) => {
      try {
        const body = reqBody(request);
        const result = await MobileDevice.create({
          deviceOs: body.deviceOs,
          deviceName: body.deviceName,
          userId: request.ep.userId,
          tenantId: request.ep.tenantId,
        });

        if (result.error)
          return response.status(400).json({ error: result.error });
        return response.status(200).json({
          token: result.device.token,
          platform: MobileDevice.platform,
        });
      } catch (e) {
        console.error(e);
        response.sendStatus(500).end();
      }
    }
  );

  app.post(
    "/mobile/send/:command",
    [validDeviceToken],
    async (request, response) => {
      try {
        return await handleMobileCommand(request, response);
      } catch (e) {
        console.error(e);
        response.sendStatus(500).end();
      }
    }
  );
}

module.exports = { mobileEndpoints };
