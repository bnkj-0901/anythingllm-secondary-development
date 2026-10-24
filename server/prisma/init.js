const fs = require("fs");
const path = require("path");
const { randomBytes, randomUUID } = require("crypto");
const bcrypt = require("bcryptjs");
const { PrismaClient } = require("@prisma/client");
const { parse } = require("dotenv");
const { runPrisma, environmentForPrisma } = require("./cli");

function administratorEnvironment(options = {}) {
  const environment = options.environment || process.env;
  const result = { ...environment };
  const directory = options.serverDirectory || path.resolve(__dirname, "..");
  try {
    const values = parse(
      (options.read || fs.readFileSync)(
        path.join(
          directory,
          environment.NODE_ENV === "production" ? ".env" : ".env.development"
        ),
        "utf8"
      )
    );
    for (const key of [
      "INITIAL_ADMIN_USERNAME",
      "INITIAL_ADMIN_PASSWORD",
      "INITIAL_ADMIN_NAME",
      "STORAGE_DIR",
      "PASSWORDMINCHAR",
      "PASSWORDMAXCHAR",
      "PASSWORDLOWERCASE",
      "PASSWORDUPPERCASE",
      "PASSWORDNUMERIC",
      "PASSWORDSYMBOL",
      "PASSWORDREQUIREMENTS",
    ])
      if (
        !Object.prototype.hasOwnProperty.call(environment, key) &&
        values[key] !== undefined
      )
        result[key] = values[key];
  } catch (error) {
    if (error.code !== "ENOENT")
      throw new Error(
        "Unable to read administrator initialization configuration"
      );
  }
  return result;
}

// Only the database deployment creates the first top administrator. A restart
// never changes an existing account or resets its password.
async function initializeAdministrator({
  prisma,
  environment = process.env,
  credentialPath,
} = {}) {
  const { User } = require("../models/user");
  return prisma.$transaction(
    async (tx) => {
      await tx.$queryRawUnsafe("SELECT pg_advisory_xact_lock(71502210)::text");
      if (await tx.ep_platform_accounts.count()) return { created: false };
      let credentials = {
        username: environment.INITIAL_ADMIN_USERNAME || "admin",
        password: environment.INITIAL_ADMIN_PASSWORD,
        name: environment.INITIAL_ADMIN_NAME || "平台管理员",
      };
      let filename;
      if (!credentials.password) {
        filename =
          credentialPath ||
          path.join(
            environment.STORAGE_DIR || path.resolve(__dirname, "../storage"),
            "initial-admin.json"
          );
        fs.mkdirSync(path.dirname(filename), { recursive: true });
        try {
          const minimum = Number(environment.PASSWORDMINCHAR || 8),
            maximum = Number(environment.PASSWORDMAXCHAR || 250);
          const length = Math.min(maximum, Math.max(35, minimum));
          let generated;
          for (let attempt = 0; attempt < 50; attempt++) {
            const candidate =
              `Aa1!${randomBytes(Math.max(length, 8)).toString("base64url")}`.slice(
                0,
                length
              );
            if (
              User.checkPasswordComplexity(candidate, environment).checkedOK
            ) {
              generated = candidate;
              break;
            }
          }
          if (!generated)
            throw new Error(
              "Configure INITIAL_ADMIN_PASSWORD to meet the deployment password rules"
            );
          fs.writeFileSync(
            filename,
            JSON.stringify({ ...credentials, password: generated }, null, 2) +
              "\n",
            { flag: "wx", mode: 0o600 }
          );
        } catch (error) {
          if (error.code !== "EEXIST") throw error;
        }
        credentials = JSON.parse(fs.readFileSync(filename, "utf8"));
      }
      credentials.username = User.validations.username(
        credentials.username.trim().toLowerCase()
      );
      if (
        !User.checkPasswordComplexity(credentials.password, environment)
          .checkedOK
      )
        throw new Error(
          "Initial administrator password does not meet the password rules"
        );
      const stamp = new Date().toISOString();
      await tx.ep_platform_accounts.create({
        data: {
          id: randomUUID(),
          username: credentials.username,
          name: credentials.name,
          passwordHash: await bcrypt.hash(credentials.password, 12),
          status: "active",
          authVersion: 1,
          createdAt: stamp,
          updatedAt: stamp,
        },
      });
      return { created: true, credentialPath: filename };
    },
    { timeout: 30000 }
  );
}

// Schema changes are explicit deployment work. Runtime requests only check readiness.
async function initializeDatabase(options = {}) {
  let result;
  try {
    result = runPrisma(["migrate", "deploy"], options);
  } catch {
    console.error("PostgreSQL database migration failed.");
    process.exitCode = 1;
    return false;
  }
  if (result.error || result.status !== 0) {
    console.error("PostgreSQL database migration failed.");
    process.exitCode = result.status || 1;
    return false;
  }
  let prisma;
  try {
    const environment = administratorEnvironment(options);
    const database = environmentForPrisma(options);
    prisma =
      options.prisma ||
      new PrismaClient({ datasources: { db: { url: database.DATABASE_URL } } });
    const admin = await (options.bootstrap || initializeAdministrator)({
      prisma,
      environment,
    });
    console.log("Knowledge platform PostgreSQL migrations deployed.");
    if (admin.created)
      console.log(
        admin.credentialPath
          ? `Initial administrator created. Credentials are saved in ${admin.credentialPath}`
          : "Initial administrator created from deployment configuration."
      );
    return true;
  } catch {
    console.error(
      "Initial administrator creation failed. Check the deployment configuration."
    );
    process.exitCode = 1;
    return false;
  } finally {
    if (prisma && !options.prisma) await prisma.$disconnect();
  }
}
if (require.main === module) initializeDatabase();
module.exports = {
  initializeDatabase,
  initializeAdministrator,
  administratorEnvironment,
};
