const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
test("communication key retains standalone payload decoding and authenticates the exact signed body", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "collector-key-"));
  t.after(() => fs.rm(directory, { force: true, recursive: true }));
  const keys = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  await fs.mkdir(path.join(directory, "comkey"));
  await fs.writeFile(
    path.join(directory, "comkey/ipc-pub.pem"),
    keys.publicKey.export({ type: "spki", format: "pem" })
  );
  const previousStorage = process.env.STORAGE_DIR;
  process.env.STORAGE_DIR = directory;
  const modulePath = require.resolve("../utils/comKey");
  delete require.cache[modulePath];
  const { CommunicationKey } = require(modulePath);
  if (previousStorage === undefined) delete process.env.STORAGE_DIR;
  else process.env.STORAGE_DIR = previousStorage;
  const key = new CommunicationKey();
  const body = '{"filename":"policy.txt"}';
  const signature = crypto
    .sign("RSA-SHA256", Buffer.from(body), keys.privateKey)
    .toString("hex");
  assert.equal(key.verify(signature, body), true);
  assert.equal(key.verify(signature, `${body} `), false);
  assert.equal(key.verify("malformed", body), false);
  const payload = crypto
    .privateEncrypt(keys.privateKey, Buffer.from("standalone payload"))
    .toString("base64");
  assert.equal(key.decrypt(payload), "standalone payload");
  assert.equal(key.verify(payload, body), false);
});
