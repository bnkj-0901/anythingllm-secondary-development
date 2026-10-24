const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { parse } = require("dotenv");

const SERVER_DIRECTORY = path.resolve(__dirname, "..");
const POSTGRES_SCHEMA = path.resolve(__dirname, "schema.prisma");
function environmentForPrisma({
  environment = process.env,
  read = fs.readFileSync,
  serverDirectory = SERVER_DIRECTORY,
} = {}) {
  const result = { ...environment };
  if (!Object.prototype.hasOwnProperty.call(environment, "DATABASE_URL")) {
    const filename = path.join(
      serverDirectory,
      environment.NODE_ENV === "production" ? ".env" : ".env.development"
    );
    try {
      const values = parse(read(filename, "utf8"));
      if (Object.prototype.hasOwnProperty.call(values, "DATABASE_URL"))
        result.DATABASE_URL = values.DATABASE_URL;
    } catch (error) {
      if (error.code !== "ENOENT")
        throw new Error("Unable to read database environment configuration");
    }
  }
  if (
    !result.DATABASE_URL ||
    !/^postgres(?:ql)?:\/\//.test(result.DATABASE_URL)
  )
    throw new Error("A PostgreSQL DATABASE_URL must be configured");
  return result;
}
function runPrisma(args, { run = spawnSync, ...options } = {}) {
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string"))
    throw new Error("Invalid Prisma command");
  const allowed =
    args[0] === "generate" ||
    (args[0] === "migrate" &&
      ["deploy", "dev", "reset", "status"].includes(args[1]));
  if (!allowed) throw new Error("Unsupported PostgreSQL Prisma command");
  if (
    args.some((arg) =>
      /^(?:--schema|--url|--datasource-provider)(?:=|$)/.test(arg)
    )
  )
    throw new Error(
      "The product Prisma schema and database configuration are fixed"
    );
  const schema = POSTGRES_SCHEMA;
  const command = [...args];
  if (
    command[0] === "migrate" &&
    ["dev", "reset"].includes(command[1]) &&
    !command.includes("--skip-seed")
  )
    command.push("--skip-seed");
  const environment = environmentForPrisma(options);
  return run(
    process.execPath,
    [require.resolve("prisma/build/index.js"), ...command, "--schema", schema],
    {
      cwd: path.dirname(schema),
      env: environment,
      stdio: "inherit",
      windowsHide: true,
    }
  );
}
if (require.main === module) {
  try {
    const result = runPrisma(process.argv.slice(2));
    process.exitCode = result.error ? 1 : result.status || 0;
  } catch {
    console.error(
      "Database command failed. Check the PostgreSQL configuration and command."
    );
    process.exitCode = 1;
  }
}
module.exports = { runPrisma, environmentForPrisma };
