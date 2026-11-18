import { createHash } from "node:crypto";

/** 本地资料统一按 UTF-8 内容计算 SHA-256。 */
export function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
