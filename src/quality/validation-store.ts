import { opendir } from "node:fs/promises";
import { ProjectFiles, hasCode } from "../storage/project-files.js";
import { IdSchema } from "../domain/common.js";
import { ValidationRunSchema, type ValidationRun } from "./validation-contracts.js";
import { z } from "zod";
import { ReviewSnapshotSchema } from "../domain/common.js";

const Started = z.object({ id: IdSchema, task_id: IdSchema, check_id: IdSchema, plan_version: ReviewSnapshotSchema,
  started_at: z.string().datetime({ offset: true }), pid: z.number().int().positive() }).strict();

const directory = (taskId: string) => `.project-dev/local/validation/${IdSchema.parse(taskId)}`;
/** 执行记录独立追加。MCP task_update 没有写入运行记录或退出码的入口。 */
export async function saveValidationRun(files: ProjectFiles, run: ValidationRun): Promise<void> {
  await files.directory(directory(run.task_id));
  const data = ValidationRunSchema.parse(run);
  await files.create(`${directory(run.task_id)}/${IdSchema.parse(run.id)}.json`, JSON.stringify(data), 1_048_576);
}
export async function validationRuns(files: ProjectFiles, taskId: string) {
  let path: string;
  try { path = await files.path(directory(taskId)); }
  catch (error) { if (hasCode(error, "ENOENT")) return { runs: [] as ValidationRun[], unfinished: [] as z.infer<typeof Started>[], truncated: false }; throw error; }
  const runs: ValidationRun[] = [], folder = await opendir(path);
  const starts: z.infer<typeof Started>[] = [];
  let count = 0;
  for await (const entry of folder) {
    if (++count > 200) return { runs, unfinished: starts, truncated: true };
    if (entry.name.endsWith(".running")) {
      const id = IdSchema.parse(entry.name.slice(0, -8));
      const start = Started.parse(JSON.parse(await files.read(`${directory(taskId)}/${id}.running`)));
      if (start.id !== id || start.task_id !== taskId) throw new Error("验证启动记录与路径不匹配");
      starts.push(start); continue;
    }
    if (!entry.name.endsWith(".json")) continue;
    const id = IdSchema.parse(entry.name.slice(0, -5));
    // 合法参数和输出经 JSON 转义后可能超过 256 KiB，读取上限覆盖契约允许的最坏情况。
    const run = ValidationRunSchema.parse(JSON.parse(await files.read(`${directory(taskId)}/${id}.json`, 1_048_576)));
    if (run.id !== id || run.task_id !== taskId) throw new Error("验证运行记录与路径不匹配");
    runs.push(run);
  }
  return { runs, unfinished: starts.filter(start => !runs.some(run => run.id === start.id)), truncated: false };
}
