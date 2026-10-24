/* global jest, test, expect */
const path = require("path");
const { environmentForPrisma, runPrisma } = require("../../prisma/cli");
const {
  initializeDatabase,
  initializeAdministrator,
  administratorEnvironment,
} = require("../../prisma/init");
const synthetic = "postgresql://synthetic:private@127.0.0.1:55432/test";
test("database commands use development config by default and production config explicitly", () => {
  for (const [environment, filename] of [
    [{}, ".env.development"],
    [{ NODE_ENV: "development" }, ".env.development"],
    [{ NODE_ENV: "production" }, ".env"],
  ]) {
    const read = jest.fn(
      () => `DATABASE_URL="${synthetic}"\nJWT_SECRET=do-not-copy`
    );
    const resolved = environmentForPrisma({
      environment,
      read,
      serverDirectory: path.resolve("synthetic-server"),
    });
    expect(read.mock.calls[0][0]).toBe(
      path.join(path.resolve("synthetic-server"), filename)
    );
    expect(resolved.DATABASE_URL).toBe(synthetic);
    expect(resolved.JWT_SECRET).toBeUndefined();
  }
});
test("explicit process database settings take precedence without reading a file", () => {
  const read = jest.fn();
  expect(
    environmentForPrisma({ environment: { DATABASE_URL: synthetic }, read })
      .DATABASE_URL
  ).toBe(synthetic);
  expect(read).not.toHaveBeenCalled();
  expect(() =>
    environmentForPrisma({ environment: { DATABASE_URL: "" }, read })
  ).toThrow("PostgreSQL DATABASE_URL");
  expect(() =>
    environmentForPrisma({
      environment: { DATABASE_URL: "file:wrong.db" },
      read,
    })
  ).toThrow("PostgreSQL DATABASE_URL");
  expect(read).not.toHaveBeenCalled();
});
test("missing or unreadable environment files fail with safe configuration errors", () => {
  expect(() =>
    environmentForPrisma({
      environment: {},
      read: () => {
        throw Object.assign(new Error("file missing"), { code: "ENOENT" });
      },
    })
  ).toThrow("PostgreSQL DATABASE_URL");
  expect(() =>
    environmentForPrisma({
      environment: {},
      read: () => {
        throw new Error("secret path details");
      },
    })
  ).toThrow("Unable to read database environment configuration");
});
test("wrapper spawns only the fixed PostgreSQL schema and preserves command arguments", () => {
  const run = jest.fn(() => ({ status: 0 }));
  for (const args of [
    ["generate"],
    ["migrate", "deploy"],
    ["migrate", "dev", "--name", "synthetic"],
    ["migrate", "reset"],
    ["migrate", "status"],
  ]) {
    runPrisma(args, { run, environment: { DATABASE_URL: synthetic } });
    const call = run.mock.calls.at(-1);
    const expected =
      args[0] === "migrate" && ["dev", "reset"].includes(args[1])
        ? [...args, "--skip-seed"]
        : args;
    expect(call[1].slice(1, -2)).toEqual(expected);
    expect(call[1].at(-1)).toMatch(/[\\/]prisma[\\/]schema.prisma$/);
    expect(call[2].env.DATABASE_URL).toBe(synthetic);
    expect(call[2].windowsHide).toBe(true);
  }
  for (const args of [
    ["db", "push"],
    ["generate", "--schema=other.prisma"],
    ["migrate", "deploy", "--url", synthetic],
    ["generate-import-client", "--force"],
    [null],
  ])
    expect(() =>
      runPrisma(args, { run, environment: { DATABASE_URL: synthetic } })
    ).toThrow();
});
test("initializer catches invalid configuration without exposing its contents", async () => {
  const log = jest.spyOn(console, "error").mockImplementation(() => {}),
    old = process.exitCode;
  try {
    expect(
      await initializeDatabase({
        environment: { DATABASE_URL: "secret-invalid-url" },
        read: jest.fn(),
      })
    ).toBe(false);
    expect(log).toHaveBeenCalledWith("PostgreSQL database migration failed.");
    expect(process.exitCode).toBe(1);
  } finally {
    process.exitCode = old;
    log.mockRestore();
  }
});

test("administrator configuration reads only bootstrap fields and preserves explicit overrides", () => {
  const resolved = administratorEnvironment({
    environment: { INITIAL_ADMIN_USERNAME: "operator" },
    read: () =>
      "INITIAL_ADMIN_USERNAME=ignored\nINITIAL_ADMIN_PASSWORD=example-password\nPASSWORDMINCHAR=12\nJWT_SECRET=do-not-copy\n",
  });
  expect(resolved.INITIAL_ADMIN_USERNAME).toBe("operator");
  expect(resolved.INITIAL_ADMIN_PASSWORD).toBe("example-password");
  expect(resolved.PASSWORDMINCHAR).toBe("12");
  expect(resolved.JWT_SECRET).toBeUndefined();
});

test("initializer stops after migration failures and reports bootstrap failures without credentials", async () => {
  const old = process.exitCode;
  const error = jest.spyOn(console, "error").mockImplementation(() => {});
  const log = jest.spyOn(console, "log").mockImplementation(() => {});
  const bootstrap = jest.fn().mockRejectedValue(new Error("secret password"));
  try {
    const options = {
      environment: { DATABASE_URL: synthetic },
      read: () => "",
      prisma: {},
      bootstrap,
    };
    expect(
      await initializeDatabase({ ...options, run: () => ({ status: 2 }) })
    ).toBe(false);
    expect(bootstrap).not.toHaveBeenCalled();
    expect(
      await initializeDatabase({ ...options, run: () => ({ status: 0 }) })
    ).toBe(false);
    expect(bootstrap).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(error.mock.calls)).not.toContain("secret password");
    bootstrap.mockResolvedValueOnce({ created: false });
    expect(
      await initializeDatabase({ ...options, run: () => ({ status: 0 }) })
    ).toBe(true);
  } finally {
    process.exitCode = old;
    error.mockRestore();
    log.mockRestore();
  }
});

test("database initialization creates one top administrator and never resets it on restart", async () => {
  const { createPostgresFixture } = require("./postgres-fixture.cjs");
  const fixture = await createPostgresFixture();
  try {
    const environment = {
      INITIAL_ADMIN_USERNAME: "operator",
      INITIAL_ADMIN_PASSWORD: "first-password-123",
    };
    expect(
      await initializeAdministrator({ prisma: fixture.prisma, environment })
    ).toEqual({ created: true, credentialPath: undefined });
    const first = await fixture.prisma.ep_platform_accounts.findFirst();
    expect(first.username).toBe("operator");
    expect(
      await require("bcryptjs").compare(
        environment.INITIAL_ADMIN_PASSWORD,
        first.passwordHash
      )
    ).toBe(true);
    expect(
      await initializeAdministrator({
        prisma: fixture.prisma,
        environment: { INITIAL_ADMIN_PASSWORD: "new-password-123" },
      })
    ).toEqual({ created: false });
    expect(await fixture.prisma.ep_platform_accounts.findMany()).toEqual([
      first,
    ]);
  } finally {
    await fixture.cleanup();
  }
}, 60000);

test("concurrent initializers create exactly one administrator using deployment password rules", async () => {
  const fixture =
    await require("./postgres-fixture.cjs").createPostgresFixture();
  try {
    const environment = {
      INITIAL_ADMIN_USERNAME: "operator",
      INITIAL_ADMIN_PASSWORD: "long-initial-password",
      PASSWORDMINCHAR: "18",
    };
    const outcomes = await Promise.all([
      initializeAdministrator({ prisma: fixture.prisma, environment }),
      initializeAdministrator({ prisma: fixture.prisma, environment }),
    ]);
    expect(outcomes.filter((value) => value.created)).toHaveLength(1);
    expect(await fixture.prisma.ep_platform_accounts.count()).toBe(1);
  } finally {
    await fixture.cleanup();
  }
}, 60000);

test("generated bootstrap credentials are persisted, reused after a failed attempt and never emitted", async () => {
  const fs = require("fs"),
    os = require("os");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "anythingllm-init-"));
  const credentialPath = path.join(directory, "initial-admin.json");
  const tx = {
    $queryRawUnsafe: jest.fn(),
    ep_platform_accounts: {
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockRejectedValueOnce(new Error("retry")),
    },
  };
  const prisma = { $transaction: (fn) => fn(tx) };
  try {
    await expect(
      initializeAdministrator({ prisma, environment: {}, credentialPath })
    ).rejects.toThrow("retry");
    const saved = JSON.parse(fs.readFileSync(credentialPath, "utf8"));
    expect(saved.password.length).toBeGreaterThan(25);
    tx.ep_platform_accounts.create.mockResolvedValueOnce({});
    expect(
      await initializeAdministrator({ prisma, environment: {}, credentialPath })
    ).toEqual({ created: true, credentialPath });
    expect(
      await require("bcryptjs").compare(
        saved.password,
        tx.ep_platform_accounts.create.mock.calls.at(-1)[0].data.passwordHash
      )
    ).toBe(true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("migration commands never register or execute the original SQLite seed", () => {
  const run = jest.fn(() => ({ status: 0 }));
  for (const command of ["dev", "reset"]) {
    runPrisma(["migrate", command, "--skip-seed"], {
      run,
      environment: { DATABASE_URL: synthetic },
    });
    expect(
      run.mock.calls.at(-1)[1].filter((arg) => arg === "--skip-seed")
    ).toHaveLength(1);
  }
  expect(require("../../package.json").prisma?.seed).toBeUndefined();
  expect(
    require("../../../package.json").scripts["prisma:seed"]
  ).toBeUndefined();
  expect(() =>
    runPrisma(["db", "seed"], { run, environment: { DATABASE_URL: synthetic } })
  ).toThrow("Unsupported PostgreSQL Prisma command");
});
