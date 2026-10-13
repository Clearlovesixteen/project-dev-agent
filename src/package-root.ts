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
      if (parent === current) throw new Error("Cannot locate the complete project-dev-agent package");
      current = parent;
    }
  }
}
