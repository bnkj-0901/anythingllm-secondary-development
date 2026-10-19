const path = require("node:path");

function relativeDocumentLocation(location, documentsDirectory, paths = path) {
  if (typeof location !== "string" || !location) throw new Error("Invalid collector document location");
  const root = paths.resolve(documentsDirectory);
  const resolved = paths.resolve(root, location);
  const relative = paths.relative(root, resolved);
  if (!relative || relative === ".." || relative.startsWith(`..${paths.sep}`) || paths.isAbsolute(relative)) throw new Error("Collector document escaped storage");
  const parts = relative.split(paths.sep);
  if (parts.length !== 2 || !parts[1].endsWith(".json")) throw new Error("Invalid collector document shape");
  return parts.join("/");
}
function installCollectorCompatibility(CollectorApi, documentsDirectory) {
  for (const name of ["processDocument", "processRawText", "processLink"]) {
    const original = CollectorApi.prototype[name];
    CollectorApi.prototype[name] = async function (...args) {
      const result = await original.apply(this, args);
      if (Array.isArray(result?.documents)) for (const document of result.documents)
        document.location = relativeDocumentLocation(document.location, documentsDirectory);
      return result;
    };
  }
}
module.exports = { relativeDocumentLocation, installCollectorCompatibility };
