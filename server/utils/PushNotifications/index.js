const webpush = require("web-push");
const fs = require("fs");
const path = require("path");
const prisma = require("../prisma");
const { refreshContext, fail } = require("../../enterprise/auth");
const { safeJsonParse } = require("../http");

/**
 * For more options, see:
 * https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerRegistration/showNotification#options
 * @typedef {Object} PushNotificationPayload
 * @property {string} title - The title of the notification.
 * @property {string} body - The message of the notification.
 * @property {Object} data - Unstructured data for the notification. Use this for anything non-standard.
 * @property {string} [data.onClickUrl] - The URL to open when the notification is clicked. Note: Can be relative or absolute.
 * @property {Object[]} actions - The actions for the notification.
 * @property {string} [actions[].action] - The action to perform when the notification is clicked. Handled in the service worker.
 * @property {string} [actions[].title] - The title of the action to show in the Options dropdown
 * @property {string} image - A string containing the URL of an image to be displayed in the notification.
 */

class PushNotifications {
  static mailTo = "anythingllm@localhost";
  /**
   * @type {PushNotifications}
   */
  static instance = null;

  /**
   * The VAPID keys for the push notification service.
   * @type {{publicKey: string | null, privateKey: string | null}}
   */
  #vapidKeys = {
    publicKey: null,
    privateKey: null,
  };

  /**
   * The subscriptions for the push notification service.
   * @type {Map<string, Object>}
   */
  #subscriptions = new Map();

  constructor() {
    if (PushNotifications.instance) return PushNotifications.instance;
    PushNotifications.instance = this;
  }

  #log(text, ...args) {
    console.log(`\x1b[36m[PushNotifications]\x1b[0m ${text}`, ...args);
  }

  get pushService() {
    try {
      const vapidKeys = this.existingVapidKeys;
      if (!vapidKeys.publicKey || !vapidKeys.privateKey)
        throw new Error(
          "VAPID keys not found. Make sure they are generated in the main process first."
        );
      webpush.setVapidDetails(
        `mailto:${this.mailTo}`,
        vapidKeys.publicKey,
        vapidKeys.privateKey
      );
      return webpush;
    } catch (e) {
      console.error("Failed to set VAPID details", e);
      return null;
    }
  }

  get storagePath() {
    return process.env.NODE_ENV === "development"
      ? path.resolve(__dirname, `../../storage`, "push-notifications")
      : path.resolve(process.env.STORAGE_DIR, "push-notifications");
  }

  get existingVapidKeys() {
    // Already loaded and binded to the instance
    if (this.#vapidKeys.publicKey && this.#vapidKeys.privateKey)
      return this.#vapidKeys;

    const vapidKeysPath = path.resolve(this.storagePath, `vapid-keys.json`);
    if (!fs.existsSync(vapidKeysPath))
      return { publicKey: null, privateKey: null };

    const existingVapidKeys = JSON.parse(
      fs.readFileSync(vapidKeysPath, "utf8")
    );
    this.#log(`Loaded existing VAPID keys!`);
    this.#vapidKeys.publicKey = existingVapidKeys.publicKey;
    this.#vapidKeys.privateKey = existingVapidKeys.privateKey;
    return this.#vapidKeys;
  }

  get publicVapidKey() {
    return this.existingVapidKeys.publicKey;
  }

  /**
   * Load the subscriptions for the push notification service.
   * Subscriptions retain the original per-user database field. Only active
   * enterprise users are loaded; sending checks that identity again.
   * @returns {Promise<void>}
   */
  async loadSubscriptions() {
    const users = await prisma.users.findMany({
      where: {
        status: "active",
        tenant: { status: "active" },
        web_push_subscription_config: { not: null },
      },
    });
    this.#subscriptions.clear();
    for (const user of users) {
      const subscription = safeJsonParse(
        user.web_push_subscription_config,
        null
      );
      if (subscription) this.#subscriptions.set(user.id, subscription);
    }
    this.#log(`Loaded ${this.#subscriptions.size} existing subscriptions.`);
  }

  /**
   * Register a new subscription for a user.
   * @param {Object} ctx - The authenticated enterprise user.
   * @param {Object} subscription - The subscription to register.
   * @returns {Promise<PushNotifications>}
   */
  async registerSubscription(ctx, subscription) {
    const current = await refreshContext(ctx);
    if (current.identity !== "tenant")
      throw fail(400, "请通过企业用户账户订阅通知");
    if (
      typeof subscription?.endpoint !== "string" ||
      !subscription.endpoint.startsWith("https://") ||
      typeof subscription.keys?.auth !== "string" ||
      typeof subscription.keys?.p256dh !== "string" ||
      JSON.stringify(subscription).length > 16384
    )
      throw fail(400, "通知订阅格式无效");
    const updated = await prisma.users.updateMany({
      where: {
        id: current.userId,
        tenantId: current.tenantId,
        status: "active",
        authVersion: current.authVersion,
        tenant: { status: "active" },
      },
      data: { web_push_subscription_config: JSON.stringify(subscription) },
    });
    if (!updated.count) throw fail(401, "账号或租户已停用，请重新登录");
    this.#subscriptions.set(current.userId, subscription);
    this.#log(
      `Registered or updated subscription for user - ${current.userId}`
    );
    return this;
  }

  /**
   * Send a notification to one currently active enterprise user.
   * @param {Object} options - The options for the notification.
   * @param {number} options.to - The execution user's ID.
   * @param {string} options.tenantId - The task's tenant.
   * @param {PushNotificationPayload} [options.payload] - The payload to send to the clients.
   * @returns {Promise<void>}
   */
  async sendNotification({ to, tenantId, payload = {} } = {}) {
    if (
      !Number.isInteger(to) ||
      to < 1 ||
      typeof tenantId !== "string" ||
      !tenantId
    )
      return;
    const user = await prisma.users.findFirst({
      where: {
        id: to,
        tenantId,
        status: "active",
        tenant: { status: "active" },
      },
    });
    const subscription = safeJsonParse(
      user?.web_push_subscription_config,
      null
    );
    if (!subscription) {
      this.#subscriptions.delete(to);
      return;
    }
    const service = this.pushService;
    if (!service) return;
    this.#log(`.sendNotification() - Sending notification to user ${to}`);
    return service
      .sendNotification(subscription, JSON.stringify(payload))
      .then((res) => {
        this.#log(
          `.sendNotification() - Delivered (status: ${res.statusCode})`
        );
      })
      .catch((err) => {
        this.#log(`.sendNotification() - Failed: ${err.message}`);
      });
  }

  /**
   * Setup the push notification service.
   * This will generate new VAPID keys if they don't exist and save them to the storage path.
   * It also loads active enterprise users' subscriptions from the database.
   * @returns {Promise<void>}
   */
  static async setupPushNotificationService() {
    const instance = PushNotifications.instance;
    const existingVapidKeys = instance.existingVapidKeys;

    if (!existingVapidKeys.publicKey || !existingVapidKeys.privateKey) {
      instance.#log("Generating new VAPID keys...");
      const vapidKeys = webpush.generateVAPIDKeys();
      instance.#vapidKeys.publicKey = vapidKeys.publicKey;
      instance.#vapidKeys.privateKey = vapidKeys.privateKey;
      instance.#log(`New VAPID keys generated!`);
      if (!fs.existsSync(instance.storagePath))
        fs.mkdirSync(instance.storagePath, { recursive: true });
      fs.writeFileSync(
        path.resolve(instance.storagePath, `vapid-keys.json`),
        JSON.stringify(vapidKeys, null, 2)
      );
    }

    await instance.loadSubscriptions();
    instance.pushService;
    return;
  }
}

module.exports = {
  pushNotificationService: new PushNotifications(),
  PushNotifications,
};
