import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { AppError } from "../domain/error.js";

const execFileAsync = promisify(execFile);

export interface GitReadResult {
  stdout: Buffer;
  exitCode: number;
}

function readEnvironment(): NodeJS.ProcessEnv {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  return { ...env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" };
}

/** Read Git without a shell, optional index writes, a pager or executable fsmonitor. */
export async function readGit(
  cwd: string,
  args: readonly string[],
  allowedExitCodes: readonly number[] = [],
): Promise<GitReadResult> {
  try {
    const result = await execFileAsync("git", [
      "--no-pager", "-c", "core.fsmonitor=false", ...args,
    ], { cwd, env: readEnvironment(), encoding: "buffer", maxBuffer: 16 * 1024 * 1024 });
    return { stdout: result.stdout, exitCode: 0 };
  } catch (error) {
    const failure = error as { code?: string | number; stdout?: Buffer };
    if (typeof failure.code === "number" && allowedExitCodes.includes(failure.code)) {
      return { stdout: failure.stdout ?? Buffer.alloc(0), exitCode: failure.code };
    }
    throw new AppError("GIT_COMMAND_FAILED", `Git ${args[0] ?? "read"} failed in the bound worktree`);
  }
}

export function decodeGitOutput(output: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(output);
  } catch {
    throw new AppError("GIT_OUTPUT_INVALID", "Git returned a path that is not valid UTF-8");
  }
}

/** Remove only Git's terminating newline, preserving whitespace in filesystem paths. */
export function gitLine(output: Buffer): string {
  const text = decodeGitOutput(output);
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}

export function assertObjectId(value: string): void {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) {
    throw new AppError("INVALID_BASELINE_HEAD", "The baseline must be a full Git commit object ID");
  }
}
