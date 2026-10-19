const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { fail } = require("./service.cjs");
const prefix = "kb_access_image_";
const hash = buffer => crypto.createHash("sha256").update(buffer).digest("hex");

function createImageDrafts({ prisma, directory, recognize, ingest }) {
  let active = 0;
  const label = id => prefix + id;
  const view = record => ({ id: record.id, title: record.title, text: record.text, status: record.status, revision: record.revision, error: record.error || "", createdAt: record.createdAt, engine: record.engine || null, progress: record.progress || null, warning: record.warning || "", previousRecognition: record.previousRecognition || null });
  async function load(space, user, id, published = false) {
    if (!/^[a-f0-9]{32}$/.test(id)) fail(404, "image_not_found", "图片草稿不存在。");
    const row = await prisma.system_settings.findUnique({ where: { label: label(id) } });
    const record = row && JSON.parse(row.value);
    if (!record || record.spaceId !== space.id || (!(published && record.status === "indexed") && record.ownerId !== user.id && user.role !== "admin")) fail(404, "image_not_found", "图片草稿不存在。");
    return record;
  }
  async function replace(old, changes) {
    const next = { ...old, ...changes };
    const result = await prisma.system_settings.updateMany({ where: { label: label(old.id), value: JSON.stringify(old) }, data: { value: JSON.stringify(next) } });
    if (!result.count) fail(409, "stale_draft", "草稿已经更新，请重新打开后核对。");
    return next;
  }
  function version(record, input) {
    if (!Number.isInteger(input.revision) || input.revision !== record.revision) fail(409, "stale_draft", "草稿已经更新，请重新打开后核对。");
  }
  function run(record) {
    Promise.resolve().then(async () => {
      let current = record;
      try {
        const result = await recognize(path.join(directory, record.id, "original"), record.mime, async ({ engine, completed, total }) => {
          current = await replace(current, { engine, progress: { completed, total } });
        });
        const text = typeof result === "string" ? result : result?.text;
        if (typeof text !== "string" || !text.trim() || Buffer.byteLength(text) > 1_000_000) throw new Error("No usable text");
        await replace(current, { recognizedText: text, text: text.trim(), engine: result?.engine || "local", warning: result?.warning || "", status: "ready", revision: record.revision + 1, error: "" });
      } catch (error) {
        const safeMessage = ["vision_provider", "vision_output", "vision_unconfigured", "vision_key_endpoint"].includes(error.code) ? error.message : "没有识别出可用文字。请重新识别、手工填写或换一张清晰图片。";
        await replace(current, { status: "failed", revision: record.revision + 1, error: safeMessage });
      }
    }).catch(error => console.error("[KnowledgeImages] OCR state update failed", error.code || error.name)).finally(() => active--);
  }
  return {
    async recover() {
      const rows = await prisma.system_settings.findMany({ where: { label: { startsWith: prefix } } });
      for (const row of rows) {
        const value = JSON.parse(row.value);
        if (["recognizing", "indexing"].includes(value.status)) await replace(value, { status: value.status === "indexing" ? "index_failed" : "failed", error: "服务重启中断了处理，请重试或手工核对文字。" });
      }
    },
    async list(space, user) {
      const rows = await prisma.system_settings.findMany({ where: { label: { startsWith: prefix }, AND: [{ value: { contains: `"spaceId":${space.id},` } }, { NOT: { value: { contains: '"status":"indexed"' } } }, ...(user.role === "admin" ? [] : [{ value: { contains: `"ownerId":${user.id},` } }])] }, orderBy: { id: "desc" }, take: 100 });
      return rows.map(row => JSON.parse(row.value)).filter(record => record.spaceId === space.id && record.status !== "indexed" && (record.ownerId === user.id || user.role === "admin")).map(view);
    },
    async create(space, user, file, validate) {
      if (active >= 2) fail(429, "ocr_busy", "图片识别正在忙，请稍后上传。");
      active++;
      let record;
      try {
        const pending = await this.list(space, user);
        if (pending.length >= 100) fail(422, "image_limit", "待确认图片已达 100 张，请先确认或删除草稿。");
        const { preview, mime } = await validate(file.buffer);
        record = { id: crypto.randomBytes(16).toString("hex"), spaceId: space.id, ownerId: user.id, title: file.originalname.replace(/\.[^.]+$/, "").slice(0, 100) || "图片资料", text: "", mime, originalSha256: hash(file.buffer), revision: 1, status: "recognizing", createdAt: new Date().toISOString() };
        await fs.mkdir(path.join(directory, record.id), { recursive: true });
        await fs.writeFile(path.join(directory, record.id, "original"), file.buffer, { flag: "wx" });
        await fs.writeFile(path.join(directory, record.id, "preview.png"), preview, { flag: "wx" });
        await prisma.system_settings.create({ data: { label: label(record.id), value: JSON.stringify(record) } });
      } catch (error) {
        active--;
        if (record) { await fs.rm(path.join(directory, record.id, "original"), { force: true }); await fs.rm(path.join(directory, record.id, "preview.png"), { force: true }); await fs.rmdir(path.join(directory, record.id)).catch(() => {}); }
        throw error;
      }
      run(record);
      return view(record);
    },
    async rerecognize(space, user, id, input) {
      const record = await load(space, user, id); version(record, input);
      if (!["ready", "failed"].includes(record.status)) fail(409, "draft_locked", "只能重新识别尚未确认的草稿。");
      const original = await fs.readFile(path.join(directory, id, "original"));
      if (hash(original) !== record.originalSha256) fail(409, "original_changed", "原图校验失败，无法重新识别。");
      if (active >= 2) fail(429, "ocr_busy", "图片识别正在忙，请稍后重试。");
      active++;
      let locked;
      try { locked = await replace(record, { status: "recognizing", revision: record.revision + 1, engine: null, progress: null, error: "", previousRecognition: { text: record.text, engine: record.engine || null, revision: record.revision } }); }
      catch (error) { active--; throw error; }
      run(locked);
      return view(locked);
    },
    async get(space, user, id) { return view(await load(space, user, id)); },
    async original(space, user, id, preview = false) {
      const record = await load(space, user, id, true);
      if (record.status === "indexed" && record.ownerId !== user.id && user.role !== "admin" && !await prisma.workspace_documents.findFirst({ where: { workspaceId: space.id, docpath: `kb-${space.id}/image-${id}.json` } })) fail(404, "image_not_found", "图片资料已经移出该知识库。");
      return { path: path.join(directory, id, preview ? "preview.png" : "original"), mime: preview ? "image/png" : record.mime };
    },
    async edit(space, user, id, input) {
      const record = await load(space, user, id); version(record, input);
      if (!["ready", "failed"].includes(record.status)) fail(409, "draft_locked", "该草稿正在处理或已经确认，不能修改。");
      if (typeof input.title !== "string" || !input.title.trim() || input.title.trim().length > 100 || typeof input.text !== "string" || !input.text.trim() || Buffer.byteLength(input.text) > 1_000_000) fail(422, "invalid_image_text", "请填写标题和正文，标题最多 100 字、正文最多 1MB。");
      return view(await replace(record, { title: input.title.trim(), text: input.text.trim(), status: "ready", revision: record.revision + 1, error: "" }));
    },
    async confirm(space, user, id, input) {
      if (input.confirmed !== true) fail(422, "confirmation_required", "请先核对原图和文字，并明确确认入库。");
      const record = await load(space, user, id); version(record, input);
      if (record.status === "indexed") return view(record);
      if (!["ready", "index_failed"].includes(record.status) || !record.text.trim()) fail(409, "draft_locked", "请等待识别完成并核对文字后再确认。");
      const original = await fs.readFile(path.join(directory, id, "original"));
      if (hash(original) !== record.originalSha256) fail(409, "original_changed", "原图校验失败，无法确认入库。");
      const snapshot = record.snapshot || { id, revision: record.revision, originalSha256: record.originalSha256, textSha256: hash(record.text), title: record.title, text: record.text, confirmedBy: user.id, confirmedAt: new Date().toISOString() };
      const locked = await replace(record, { status: "indexing", snapshot, error: "" });
      try {
        await ingest({ space, user, title: snapshot.title, text: snapshot.text, imageSnapshot: snapshot });
        return view(await replace(locked, { status: "indexed" }));
      } catch {
        await replace(locked, { status: "index_failed", error: "索引未完成，已保留确认内容。请检查向量服务后重试入库。" });
        fail(502, "image_index_failed", "索引未完成，已保留确认内容，可重试入库。");
      }
    },
    async remove(space, user, id) {
      const record = await load(space, user, id);
      if (["recognizing", "indexing", "indexed", "index_failed"].includes(record.status)) fail(409, "draft_locked", "处理中或已确认的图片不能作为草稿删除。");
      const result = await prisma.system_settings.deleteMany({ where: { label: label(id), value: JSON.stringify(record) } });
      if (!result.count) fail(409, "stale_draft", "草稿已经更新，请重新打开。");
      await fs.rm(path.join(directory, id, "original"), { force: true });
      await fs.rm(path.join(directory, id, "preview.png"), { force: true });
      await fs.rmdir(path.join(directory, id));
    },
  };
}
module.exports = { createImageDrafts };
