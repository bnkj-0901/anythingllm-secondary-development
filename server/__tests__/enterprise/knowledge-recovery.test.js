const mockStore = { all: jest.fn(async () => []) };
const mockVectors = { recoverCleanup: jest.fn() };
const mockFiles = { recoverCleanup: jest.fn() };
jest.mock("../../enterprise/store", () => mockStore);
jest.mock("../../enterprise/vector-store", () => mockVectors);
jest.mock("../../enterprise/file-store", () => mockFiles);
jest.mock("../../enterprise/providers", () => ({}));
jest.mock("../../enterprise/auth", () => ({
  fail: (status, message) => Object.assign(new Error(message), { status }),
}));
jest.mock("../../enterprise/rag-settings", () => ({}));
const { startRecovery, recoverJobs } = require("../../enterprise/knowledge");

beforeEach(() => {
  jest.clearAllMocks();
  mockFiles.recoverCleanup.mockResolvedValue(true);
  mockVectors.recoverCleanup.mockResolvedValue(true);
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

test("temporary vector unavailability schedules a later recovery instead of abandoning processing jobs", async () => {
  mockVectors.recoverCleanup.mockResolvedValueOnce(false);
  const scheduled = [];
  const unref = jest.fn();
  await startRecovery({
    schedule: (fn, delay) => {
      scheduled.push({ fn, delay });
      return { unref };
    },
  });
  expect(mockStore.all).not.toHaveBeenCalled();
  expect(scheduled[0].delay).toBe(1000);
  await scheduled[0].fn();
  expect(mockStore.all).toHaveBeenCalledTimes(2);
  expect(unref).toHaveBeenCalledTimes(1);
  expect(scheduled).toHaveLength(1);
});

test("file cleanup failures preserve processing-job recovery and bound exponential retries", async () => {
  mockFiles.recoverCleanup.mockResolvedValue(false);
  const scheduled = [];
  await startRecovery({
    attempts: 3,
    schedule: (fn, delay) => {
      scheduled.push({ fn, delay });
    },
  });
  await scheduled[0].fn();
  await scheduled[1].fn();
  expect(scheduled.map((item) => item.delay)).toEqual([1000, 2000]);
  expect(mockStore.all).toHaveBeenCalledTimes(6);
  expect(mockFiles.recoverCleanup).toHaveBeenCalledTimes(3);
});

test("explicit recovery reports unavailable cleanup and remains repeatable", async () => {
  mockVectors.recoverCleanup.mockResolvedValueOnce(false);
  await expect(recoverJobs()).rejects.toMatchObject({ status: 503 });
  await expect(recoverJobs()).resolves.toBeUndefined();
  expect(mockStore.all).toHaveBeenCalledTimes(2);
});
