import { access, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export async function findToolRoot(): Promise<string> {
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
