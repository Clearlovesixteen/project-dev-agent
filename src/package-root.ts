import { access, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export async function findToolRoot(): Promise<string> {
  // 压缩发布包从用户缓存运行时，必须保留原插件根目录用于读取 Skill、模板和配置。
  const configuredRoot = process.env.PROJECT_DEV_PLUGIN_ROOT;
  if (configuredRoot) {
    const root = resolve(configuredRoot);
    try {
      await access(join(root, "package.json"));
      await access(join(root, "fixtures", "sample-project-template"));
      await access(join(root, "skills", "project-dev", "SKILL.md"));
      return await realpath(root);
    } catch {
      throw new Error("PROJECT_DEV_PLUGIN_ROOT 不是完整的 project-dev-agent 软件包");
    }
  }
  let current = dirname(fileURLToPath(import.meta.url));
  while (true) {
    try {
      await access(join(current, "package.json"));
      await access(join(current, "fixtures", "sample-project-template"));
      await access(join(current, "skills", "project-dev", "SKILL.md"));
      return await realpath(current);
    } catch {
      const parent = dirname(current);
      if (parent === current) throw new Error("无法找到完整的 project-dev-agent 软件包");
      current = parent;
    }
  }
}

export async function findCliPath(root: string): Promise<string> {
  const bundled = join(root, "runtime/cli.mjs");
  try { await access(bundled); return bundled; } catch { return join(root, "dist/src/cli.js"); }
}
