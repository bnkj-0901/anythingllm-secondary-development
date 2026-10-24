const fs = require("fs");
const path = require("path");
const { log, conclude } = require("./helpers/index.js");
const prisma = require("../utils/prisma");
const {
  generatedImagesPath,
  GENERATED_IMAGE_FILENAME_PATTERN,
} = require("../utils/files/index.js");
const { safeJsonParse } = require("../utils/http/index.js");

// Ignore images younger than this so a freshly generated file isn't deleted in
// the window between writing it to disk and persisting its chat reference.
const MIN_AGE_MS = 60 * 60 * 1000;

async function cleanupGeneratedImages() {
  try {
    if (!fs.existsSync(generatedImagesPath)) return;

    const now = Date.now();
    const candidates = fs
      .readdirSync(generatedImagesPath)
      .filter((name) => GENERATED_IMAGE_FILENAME_PATTERN.test(name))
      .filter(
        (name) =>
          now - fs.statSync(path.join(generatedImagesPath, name)).mtimeMs >
          MIN_AGE_MS
      );
    if (candidates.length === 0) return;

    const referenced = await referencedImageFilenames();
    const orphans = candidates.filter((name) => !referenced.has(name));
    if (orphans.length === 0) return;

    log(`Found ${orphans.length} orphaned images to delete.`);
    let deleted = 0;
    for (const name of orphans) {
      try {
        fs.unlinkSync(path.join(generatedImagesPath, name));
        deleted++;
      } catch (error) {
        log(`Failed to delete ${name}: ${error.message}`);
      }
    }
    log(`Cleanup complete: deleted ${deleted}/${orphans.length} images.`);
  } catch (error) {
    console.error(error);
    log(`Error during cleanup: ${error.message}`);
  }
}

/**
 * Collects every generated-image filename referenced by retained chat history or
 * completed scheduled job run.
 * @returns {Promise<Set<string>>}
 */
async function referencedImageFilenames() {
  const filenames = new Set();

  for await (const chat of activeImageChats()) {
    extractImageFilenames(chat.response, filenames);
  }

  for await (const run of completedImageRuns()) {
    extractImageFilenames(run.result, filenames);
  }

  return filenames;
}

function extractImageFilenames(jsonString, into) {
  const { outputs } = safeJsonParse(jsonString, { outputs: [] });
  for (const output of outputs || []) {
    const storageFilename = output?.payload?.storageFilename;
    if (GENERATED_IMAGE_FILENAME_PATTERN.test(storageFilename))
      into.add(storageFilename);
  }
}

/**
 * Yields all retained chats that reference a generated image, one batch at a time, so
 * the full chat table is never held in memory. The `img-` filter narrows the
 * scan to chats that can actually hold an image reference.
 * @param {number} batchSize - chats fetched per query
 * @returns {AsyncGenerator<object>}
 */
async function* activeImageChats(batchSize = 50) {
  let offset = 0;
  while (true) {
    const chats = await prisma.chats.findMany({
      where: { include: true, response: { contains: "img-" } },
      select: { response: true },
      take: batchSize,
      orderBy: { id: "asc" },
      skip: offset,
    });
    if (chats.length === 0) return;
    yield* chats;
    if (chats.length < batchSize) return;
    offset += chats.length;
  }
}

/**
 * Yields completed scheduled job runs that reference a generated image.
 * @param {number} batchSize
 * @returns {AsyncGenerator<object>}
 */
async function* completedImageRuns(batchSize = 50) {
  let offset = 0;
  while (true) {
    const runs = await prisma.scheduled_job_runs.findMany({
      where: { status: "completed", result: { contains: "img-" } },
      select: { result: true },
      take: batchSize,
      orderBy: { id: "asc" },
      skip: offset,
    });
    if (runs.length === 0) return;
    yield* runs;
    if (runs.length < batchSize) return;
    offset += runs.length;
  }
}

if (require.main === module) cleanupGeneratedImages().finally(conclude);
module.exports = { cleanupGeneratedImages, referencedImageFilenames };
