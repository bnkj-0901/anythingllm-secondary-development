const path = require("node:path");
const { serverDirectory } = require("./dependencies.cjs");
const OCRLoader = require(path.resolve(serverDirectory, "../collector/utils/OCRLoader"));
async function recognize(file) {
  const loader = new OCRLoader({ targetLanguages: "chi_sim,eng" });
  return loader.ocrImage(file, { maxExecutionTime: 120_000 });
}
recognize(process.argv[2])
  .then(text => process.send({ text: typeof text === "string" ? text : "" }, () => process.exit(0)))
  .catch(() => process.exit(1));
