/* global jest, beforeEach, test, expect */
const mockInit = jest.fn();
const mockBootHTTP = jest.fn();
const mockBootSSL = jest.fn();
const mockCreateApp = jest.fn();
const mockCommunicationKey = jest.fn();
const mockLoadPlatformEnvironment = jest.fn();
const mockInitializeVectorSettings = jest.fn();
const mockBackgroundBoot = jest.fn();
const mockTelegramBoot = jest.fn();
const mockPushSetup = jest.fn();
jest.mock("../../utils/telemetry", () => jest.fn());
jest.mock("../../utils/EncryptionManager", () => ({ EncryptionManager: jest.fn() }));
jest.mock("../../utils/boot/eagerLoadContextWindows", () => jest.fn());
jest.mock("../../utils/BackgroundWorkers", () => ({ BackgroundService: jest.fn(() => ({boot: mockBackgroundBoot})) }));
jest.mock("../../utils/telegramBot", () => ({ TelegramBotService: {bootIfActive:mockTelegramBoot} }));
jest.mock("../../utils/PushNotifications", () => ({ PushNotifications: {setupPushNotificationService:mockPushSetup} }));
jest.mock("../../enterprise/store", () => ({ init: mockInit }));
jest.mock("../../enterprise/settings", () => ({
  loadPlatformEnvironment: mockLoadPlatformEnvironment,
}));
jest.mock("../../enterprise/vector-config", () => ({
  initializeVectorSettings: mockInitializeVectorSettings,
}));
jest.mock("../../app", () => ({ createApp: mockCreateApp }));
jest.mock("../../utils/boot", () => ({
  bootHTTP: mockBootHTTP,
  bootSSL: mockBootSSL,
}));
jest.mock("../../utils/logger", () => () => {});
jest.mock("../../utils/boot/patchSdkTimeouts", () => () => {});
jest.mock("../../utils/helpers/modelPricing", () => ({}));
jest.mock("../../utils/config/credentials", () => ({
  ensureCredentials: jest.fn(),
}));
jest.mock("../../utils/comKey", () => ({
  CommunicationKey: mockCommunicationKey,
}));
jest.mock("dotenv", () => ({ config: jest.fn() }));
const { startServer } = require("../../index");
beforeEach(() => {
  jest.clearAllMocks();
  mockCreateApp.mockReturnValue({});
  mockInit.mockResolvedValue({ provider: "postgresql" });
  mockLoadPlatformEnvironment.mockResolvedValue(undefined);
  mockInitializeVectorSettings.mockResolvedValue(true);
});

test("unavailable or unmigrated PostgreSQL prevents exposing a listening API", async () => {
  mockInit.mockRejectedValueOnce(new Error("unavailable"));
  await expect(startServer()).rejects.toThrow("unavailable");
  expect(mockCreateApp).not.toHaveBeenCalled();
  expect(mockBootHTTP).not.toHaveBeenCalled();
  expect(mockBootSSL).not.toHaveBeenCalled();
});

test("healthy HTTP startup waits for database readiness and initializes the signed Collector channel", async () => {
  const previous = {
    ENABLE_HTTPS: process.env.ENABLE_HTTPS,
    SERVER_PORT: process.env.SERVER_PORT,
  };
  delete process.env.ENABLE_HTTPS;
  delete process.env.SERVER_PORT;
  try {
    await startServer();
    expect(mockInit.mock.invocationCallOrder[0]).toBeLessThan(
      mockLoadPlatformEnvironment.mock.invocationCallOrder[0]
    );
    expect(
      mockLoadPlatformEnvironment.mock.invocationCallOrder[0]
    ).toBeLessThan(mockInitializeVectorSettings.mock.invocationCallOrder[0]);
    expect(
      mockInitializeVectorSettings.mock.invocationCallOrder[0]
    ).toBeLessThan(mockCreateApp.mock.invocationCallOrder[0]);
    expect(mockBootHTTP).toHaveBeenCalledWith(
      mockCreateApp.mock.results[0].value,
      3001,
      expect.any(Function)
    );
    await mockBootHTTP.mock.calls[0][2]();
    expect(mockCommunicationKey).toHaveBeenCalledWith(true);
    expect(mockBackgroundBoot).toHaveBeenCalledTimes(1);
    expect(mockTelegramBoot).toHaveBeenCalledTimes(1);
    expect(mockPushSetup).toHaveBeenCalledTimes(1);
  } finally {
    for (const [key, value] of Object.entries(previous))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  }
});

test("unreadable saved platform settings prevent starting with different runtime credentials", async () => {
  mockLoadPlatformEnvironment.mockRejectedValueOnce(
    new Error("settings unavailable")
  );
  await expect(startServer()).rejects.toThrow("settings unavailable");
  expect(mockCreateApp).not.toHaveBeenCalled();
  expect(mockBootHTTP).not.toHaveBeenCalled();
});

test("invalid initial vector configuration prevents exposing a listening API", async () => {
  mockInitializeVectorSettings.mockRejectedValueOnce(
    new Error("invalid vector settings")
  );
  await expect(startServer()).rejects.toThrow("invalid vector settings");
  expect(mockCreateApp).not.toHaveBeenCalled();
  expect(mockBootHTTP).not.toHaveBeenCalled();
  expect(mockBootSSL).not.toHaveBeenCalled();
});

test("configured TLS startup keeps the original HTTPS boot implementation", async () => {
  const previous = {
    NODE_ENV: process.env.NODE_ENV,
    ENABLE_HTTPS: process.env.ENABLE_HTTPS,
    SERVER_PORT: process.env.SERVER_PORT,
  };
  process.env.NODE_ENV = "development";
  process.env.ENABLE_HTTPS = "1";
  process.env.SERVER_PORT = "3443";
  try {
    await startServer();
    expect(mockBootSSL).toHaveBeenCalledWith(
      mockCreateApp.mock.results[0].value,
      3443,
      expect.any(Function)
    );
    expect(mockBootHTTP).not.toHaveBeenCalled();
  } finally {
    for (const [key, value] of Object.entries(previous))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  }
});
