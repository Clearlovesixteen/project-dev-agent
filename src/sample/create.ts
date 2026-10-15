import { execFile } from "node:child_process";
import { cp, mkdir, realpath, rm, rename } from "node:fs/promises";
import { devNull } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { findToolRoot } from "../package-root.js";

const execFileAsync = promisify(execFile);

function gitEnvironment(): NodeJS.ProcessEnv {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: devNull,
    GIT_TERMINAL_PROMPT: "0",
  };
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync("git", [
    "-c", `core.hooksPath=${devNull}`,
    "-c", "commit.gpgsign=false",
    "-c", "user.name=Project Dev Agent Sample",
    "-c", "user.email=project-dev-agent@example.invalid",
    ...args,
  ], { cwd, env: gitEnvironment(), encoding: "utf8" });
  return result.stdout.trim();
}

/** Create a new external sample repository. Its parent directory must already exist. */
export async function createSample(destination: string): Promise<{ path: string; head: string }> {
  if (!destination.trim()) throw new Error("请指定示例项目的目标目录");
  const toolRoot = await findToolRoot();
  const requestedPath = resolve(destination);
  const parent = await realpath(dirname(requestedPath));
  const target = join(parent, basename(requestedPath));
  const withinTool = relative(toolRoot, target);
  if (withinTool === "" || (!withinTool.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
    && withinTool !== ".." && !isAbsolute(withinTool))) {
    throw new Error("示例目标目录必须位于工具包之外");
  }

  let created = false;
  try {
    // Exclusive creation rejects existing directories, including empty ones and symlinks.
    await mkdir(target);
    created = true;
    await cp(join(toolRoot, "fixtures", "sample-project-template"), target, {
      recursive: true,
      force: false,
      errorOnExist: true,
      filter: (source) => ![".git", ".gitignore"].includes(basename(source)),
    });
    // npm excludes .gitignore files from tarballs, so the package carries a named template.
    await rename(join(target, "gitignore.template"), join(target, ".gitignore"));
    await git(target, ["init", "--template=", "--initial-branch=main"]);
    await git(target, ["add", "--all"]);
    await git(target, ["commit", "--no-gpg-sign", "-m", "初始化账户示例基线"]);
    const head = await git(target, ["rev-parse", "HEAD"]);
    return { path: target, head };
  } catch (error) {
    if (created) await rm(target, { recursive: true, force: true });
    throw error;
  }
}
