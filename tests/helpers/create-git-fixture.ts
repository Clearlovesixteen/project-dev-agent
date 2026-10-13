import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSample } from "../../src/sample/create.js";

export interface GitFixture {
  root: string;
  path: string;
  head: string;
  cleanup(): Promise<void>;
}

export async function createGitFixture(): Promise<GitFixture> {
  const root = await mkdtemp(join(tmpdir(), "project-dev-agent-sample-"));
  try {
    const sample = await createSample(join(root, "account sample"));
    return {
      root,
      ...sample,
      cleanup: () => rm(root, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
