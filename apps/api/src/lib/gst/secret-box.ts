import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// AES-256-GCM for GST tokens at rest. The key is GST_TOKEN_ENCRYPTION_KEY:
// 32 random bytes, base64 (node -e "console.log(require('crypto').randomBytes(32).toString('base64'))").
function keyFrom(base64Key: string | undefined) {
  const key = Buffer.from(String(base64Key || ""), "base64");
  if (key.length !== 32) throw new Error("GST_TOKEN_ENCRYPTION_KEY must be 32 bytes, base64 encoded.");
  return key;
}

export function encryptSecret(plain: string, base64Key = process.env.GST_TOKEN_ENCRYPTION_KEY) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFrom(base64Key), iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), body.toString("base64url")].join(".");
}

export function decryptSecret(stored: string, base64Key = process.env.GST_TOKEN_ENCRYPTION_KEY) {
  const [version, iv, tag, body] = String(stored || "").split(".");
  if (version !== "v1" || !iv || !tag || !body) throw new Error("Stored GST token is not in a known format.");
  const decipher = createDecipheriv("aes-256-gcm", keyFrom(base64Key), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8");
}
