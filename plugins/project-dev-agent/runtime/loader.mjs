// 运行时启动器只负责解压并校验版本化资产，业务逻辑位于用户缓存目录。
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const VERSION = "0.16.0";
const ARCHIVE_SHA256 = "d6497add71cceb44e3d5869a0fdc43147b0bac5d443bca9af1b7b8235e304051";
const RUNTIME_FILES = ["cli.mjs","hooks.mjs","symbol-index.mjs","behavior-reporter.mjs"];

function readField(buffer, start, length) {
  return buffer.subarray(start, start + length).toString("utf8").replace(/\0.*$/, "");
}

function parseTar(buffer) {
  const files = new Map();
  let offset = 0;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const name = readField(header, 0, 100);
    const sizeText = readField(header, 124, 12).trim();
    const size = Number.parseInt(sizeText || "0", 8);
    if (!name || !Number.isSafeInteger(size) || size < 0) throw new Error("运行包 tar 头无效");
    if (isAbsolute(name) || name.split("/").includes("..")) throw new Error("运行包包含越界路径");
    const start = offset + 512;
    const end = start + size;
    if (end > buffer.length) throw new Error("运行包内容不完整");
    if (RUNTIME_FILES.includes(name)) files.set(name, buffer.subarray(start, end));
    offset = start + Math.ceil(size / 512) * 512;
  }
  if (files.size !== RUNTIME_FILES.length) throw new Error("运行包缺少运行时文件");
  return files;
}

export async function ensureRuntime(importMetaUrl) {
  const pluginRoot = resolve(dirname(fileURLToPath(importMetaUrl)), "..");
  const archivePath = join(pluginRoot, "runtime/runtime-bundle.tgz");
  const archive = await readFile(archivePath);
  const digest = createHash("sha256").update(archive).digest("hex");
  if (digest !== ARCHIVE_SHA256) throw new Error("运行包校验失败");

  const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
  const cacheRoot = join(codexHome, "cache", "project-dev-agent", "runtime", VERSION, ARCHIVE_SHA256);
  const marker = join(cacheRoot, ".complete");
  const hasCompleteRuntime = async () => {
    try {
      if ((await readFile(marker, "utf8")).trim() !== ARCHIVE_SHA256) return false;
      for (const name of RUNTIME_FILES) await stat(join(cacheRoot, name));
      return true;
    } catch { return false; }
  };
  if (await hasCompleteRuntime()) return { pluginRoot, runtimeRoot: cacheRoot };

  await mkdir(dirname(cacheRoot), { recursive: true });
  const temporary = join(dirname(cacheRoot), `.tmp-${process.pid}-${Date.now()}`);
  await rm(temporary, { recursive: true, force: true });
  await mkdir(temporary, { recursive: true });
  try {
    for (const [name, data] of parseTar(gunzipSync(archive))) {
      await writeFile(join(temporary, name), data, { mode: 0o644 });
    }
    await writeFile(join(temporary, ".complete"), `${ARCHIVE_SHA256}\n`);
    try {
      await rename(temporary, cacheRoot);
    } catch (error) {
      if (!["EEXIST", "ENOTEMPTY"].includes(error?.code)) throw error;
      // 并发进程可能已经原子发布了同一个版本。macOS 对已存在的非空目录返回 ENOTEMPTY。
      if (!(await hasCompleteRuntime())) {
        await rm(cacheRoot, { recursive: true, force: true });
        try { await rename(temporary, cacheRoot); } catch (retryError) {
          if (!["EEXIST", "ENOTEMPTY"].includes(retryError?.code)) throw retryError;
        }
      }
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  if (!(await hasCompleteRuntime())) throw new Error("运行时缓存发布不完整");
  return { pluginRoot, runtimeRoot: cacheRoot };
}

export function runtimeImport(runtimeRoot, name) {
  return pathToFileURL(join(runtimeRoot, name)).href;
}
