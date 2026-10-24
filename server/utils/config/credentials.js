const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

function ensureCredentials() {
  const missing = ["JWT_SECRET", "SIG_KEY", "SIG_SALT"].filter(
    (name) => !process.env[name]
  );
  if (!missing.length) return;
  const environmentFile = path.resolve(
    __dirname,
    "../..",
    process.env.NODE_ENV === "development" ? ".env.development" : ".env"
  );
  const existing = fs.existsSync(environmentFile)
    ? fs.readFileSync(environmentFile, "utf8")
    : "";
  const entries = missing.map((name) => {
    const value = crypto.randomBytes(32).toString("hex");
    process.env[name] = value;
    return `${name}=${value}`;
  });
  fs.appendFileSync(
    environmentFile,
    `${existing.endsWith("\n") ? "" : "\n"}${entries.join("\n")}\n`,
    { mode: 0o600 }
  );
}
module.exports = { ensureCredentials };
