import fs from "node:fs";
import path from "node:path";

const collections = new Map();

async function openCollection({ indexPath, dimensions }) {
  const key = `${indexPath}|${dimensions}`;
  if (collections.has(key)) return collections.get(key);
  const zvec = await import("@zvec/zvec");
  // Zvec creates the collection directory itself. Pre-creating that exact
  // directory on Windows prevents it from creating its LOCK file.
  fs.mkdirSync(path.dirname(indexPath), { recursive: true, mode: 0o700 });
  let collection;
  const existingManifest = fs.existsSync(`${indexPath}/manifest.0`) || fs.existsSync(`${indexPath}/manifest.json`);
  if (existingManifest && typeof zvec.ZVecOpen === "function") {
    collection = zvec.ZVecOpen(indexPath);
  } else {
    const schema = new zvec.ZVecCollectionSchema({
      name: "kalika_ledgers",
      vectors: { name: "embedding", dataType: zvec.ZVecDataType.VECTOR_FP32, dimension: dimensions },
    });
    try { collection = zvec.ZVecCreateAndOpen(indexPath, schema); }
    catch (error) {
      if (typeof zvec.ZVecOpen !== "function") throw error;
      collection = zvec.ZVecOpen(indexPath);
    }
  }
  collections.set(key, collection);
  return collection;
}

async function execute(message) {
  const collection = await openCollection(message);
  if (message.operation === "upsert") {
    const documents = (message.documents || []).map((document) => ({ id: document.id, vectors: { embedding: document.embedding } }));
    if (typeof collection.upsertSync === "function") collection.upsertSync(documents);
    else {
      for (const document of documents) {
        try { collection.deleteSync?.([document.id]); } catch {}
      }
      collection.insertSync(documents);
    }
    return { count: documents.length };
  }
  if (message.operation === "query") {
    return collection.querySync({ fieldName: "embedding", vector: message.embedding, topk: Math.max(1, Math.min(20, message.topK || 5)) })
      .map((result) => ({ id: result.id, score: result.score }));
  }
  if (message.operation === "delete") {
    const ids = (message.ids || []).map(String).filter(Boolean);
    if (ids.length) collection.deleteSync?.(ids);
    return { count: ids.length };
  }
  if (message.operation === "close") {
    collection.close?.();
    collections.clear();
    return true;
  }
  throw new Error(`Unknown vector operation: ${message.operation}`);
}

process.on("message", async (message) => {
  try { process.send?.({ id: message.id, result: await execute(message) }); }
  catch (error) { process.send?.({ id: message.id, error: { code: "VECTOR_INDEX_ERROR", message: error instanceof Error ? error.message : String(error) } }); }
});

