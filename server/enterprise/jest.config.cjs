const path = require("path");

module.exports = {
  ...require("../../jest.config.cjs"),
  rootDir: path.resolve(__dirname, "../.."),
  testMatch: ["<rootDir>/server/__tests__/enterprise/**/*.test.js"],
  // Integration fixtures deploy real PostgreSQL schemas before each suite.
  testTimeout: 30000,
  collectCoverageFrom: [
    "server/enterprise/**/*.js",
    "server/models/user.js",
    "server/models/documents.js",
    "server/models/vectors.js",
    "server/models/workspaceChats.js",
    "server/models/workspaceThread.js",
  ],
  coverageReporters: ["text", "json-summary", "lcov"],
  coverageDirectory: "coverage/enterprise",
  coverageThreshold: {
    global: { statements: 90, branches: 85, functions: 90, lines: 90 },
  },
};
