const path = require("path");

async function startServer() {
  const environmentFile =
    process.env.NODE_ENV === "development" ? ".env.development" : ".env";
  require("dotenv").config({
    path: path.resolve(__dirname, environmentFile),
  });
  require("./utils/logger")();
  require("./utils/boot/patchSdkTimeouts")();
  require("./utils/helpers/modelPricing");
  const { ensureCredentials } = require("./utils/config/credentials");
  const { CommunicationKey } = require("./utils/comKey");
  const { EncryptionManager } = require("./utils/EncryptionManager");
  const { bootHTTP, bootSSL } = require("./utils/boot");
  ensureCredentials();
  await require("./enterprise/store").init();
  await require("./enterprise/settings").loadPlatformEnvironment();
  await require("./enterprise/vector-config").initializeVectorSettings();
  const app = require("./app").createApp();
  const boot = process.env.ENABLE_HTTPS ? bootSSL : bootHTTP;
  boot(app, Number(process.env.SERVER_PORT) || 3001, async () => {
    await require("./utils/telemetry")();
    new CommunicationKey(true);
    new EncryptionManager();
    new (require("./utils/BackgroundWorkers").BackgroundService)().boot();
    await require("./utils/boot/eagerLoadContextWindows")();
    await require("./utils/PushNotifications").PushNotifications.setupPushNotificationService();
    await require("./utils/telegramBot").TelegramBotService.bootIfActive();
  });
}

if (require.main === module)
  startServer().catch(() => {
    console.error(
      "SaaS startup failed. Check PostgreSQL connectivity and run db:init before starting the server."
    );
    process.exitCode = 1;
  });
module.exports = { startServer };
