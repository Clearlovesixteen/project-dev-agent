import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
type SampleGit = (cwd: string, args: readonly string[]) => Promise<string>;

/** 使用真实空配置和空 hooks 目录隔离样例 Git，兼容 Windows Git，不依赖系统空设备路径。 */
export async function withSampleGit<T>(parent: string, action: (git: SampleGit) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(parent, ".project-dev-sample-git-"));
  try {
    const hooks = join(directory, "hooks"), config = join(directory, "config");
    await mkdir(hooks); await writeFile(config, "", { mode: 0o600 });
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")));
    const env = { ...inherited, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: config, GIT_TERMINAL_PROMPT: "0" };
    return await action(async (cwd, args) => {
      const result = await execute("git", ["-c", `core.hooksPath=${hooks}`, "-c", "commit.gpgsign=false",
        "-c", "user.name=Project Dev Agent Sample", "-c", "user.email=project-dev-agent@example.invalid", ...args],
      { cwd, env, encoding: "utf8" });
      return result.stdout.trim();
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
}
