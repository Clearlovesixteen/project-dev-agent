import { homedir } from "node:os";
import { join } from "node:path";
import { opendir } from "node:fs/promises";
import { AppError } from "../domain/error.js";
import { assertStateIgnored, type WorktreeBinding } from "../git/index.js";
import { ProjectFiles, hasCode } from "../storage/project-files.js";
import { acquireFileLock } from "../storage/file-lock.js";
import { digest } from "../knowledge/document.js";
import { matchesPath } from "../knowledge/config.js";
import { queryTerms } from "../understanding/retrieval.js";
import {
  belongsToProject,
  discoverSessions,
  historyHome,
  parseSession,
  sessionMeta,
} from "../history/codex-reader.js";
import {
  FeedbackInputSchema,
  FeedbackRecordSchema,
  type FeedbackRecord,
} from "./contracts.js";
const DIRECTORY = ".project-dev/local/feedback";

/** 即时纠正独立于任务保存，引用必须来自本项目可读取的真实用户消息。 */
export async function recordFeedback(
  binding: WorktreeBinding,
  value: unknown,
  codexHome = process.env.CODEX_HOME || join(homedir(), ".codex"),
) {
  const input = FeedbackInputSchema.parse(value);
  await assertStateIgnored(binding);
  const files = new ProjectFiles(binding.root);
  await files.directory(DIRECTORY);
  const release = await acquireFileLock(
    files,
    `${DIRECTORY}/operation.lock`,
    "FEEDBACK_BUSY",
  );
  try {
    const prior = (await feedbackRecords(files)).find(
      (item) => item.input.id === input.id,
    );
    if (prior) {
      if (JSON.stringify(prior.input) !== JSON.stringify(input))
        throw new AppError(
          "FEEDBACK_IMMUTABLE",
          "纠正记录不可覆盖，请用新ID和supersedes_id追加修订",
        );
      return prior;
    }
    const all = await feedbackRecords(files);
    if (all.length >= 200)
      throw new AppError(
        "FEEDBACK_LIMIT",
        "项目即时纠正达到200条，请整理范围后继续",
      );
    if (input.status === "disabled" && !input.supersedes_id)
      throw new AppError("FEEDBACK_INVALID", "停用须明确被替代的纠正ID");
    if (
      input.supersedes_id &&
      (!all.some((item) => item.input.id === input.supersedes_id) ||
        all.some((item) => item.input.supersedes_id === input.supersedes_id))
    )
      throw new AppError(
        "FEEDBACK_SUPERSEDES",
        "只允许替代尚未被修订的本项目纠正",
      );
    const home = await historyHome(codexHome),
      inventory = await discoverSessions(home);
    const matches = [];
    for (const file of inventory.files) {
      const meta = await sessionMeta(file);
      if (
        meta.internal ||
        (input.source.session_id && meta.id !== input.source.session_id) ||
        !(await belongsToProject(meta.cwd, binding.root))
      )
        continue;
      const parsed = await parseSession(file, meta, binding.root);
      for (const message of parsed.messages)
        if (
          message.role === "user" &&
          (!input.source.message_id ||
            message.id === input.source.message_id) &&
          message.text.includes(input.source.quote)
        )
          matches.push(message);
      if (matches.length > 1) break;
    }
    if (matches.length !== 1)
      throw new AppError(
        "FEEDBACK_SOURCE_INVALID",
        matches.length
          ? "用户原话命中多条消息，请明确session_id或message_id"
          : "未找到当前项目的用户原话；不能用助手说明或其他项目记录代替",
      );
    const message = matches[0]!,
      source = {
        session: message.session,
        message_id: message.id,
        line: message.line,
        quote: input.source.quote,
        source_hash: digest(message.text),
      };
    const record = FeedbackRecordSchema.parse({
      input,
      source,
      fingerprint: digest(JSON.stringify([input, source])),
      recorded_at: new Date().toISOString(),
    });
    await files.create(`${DIRECTORY}/${input.id}.json`, JSON.stringify(record));
    return record;
  } finally {
    await release();
  }
}
export async function feedbackRecords(
  files: ProjectFiles,
): Promise<FeedbackRecord[]> {
  let directory: string;
  try {
    directory = await files.path(DIRECTORY);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return [];
    throw error;
  }
  const records = [];
  let count = 0;
  for await (const entry of await opendir(directory)) {
    if (++count > 205)
      throw new AppError("FEEDBACK_LIMIT", "即时纠正目录超出读取上限");
    if (!entry.name.endsWith(".json")) continue;
    const value = FeedbackRecordSchema.parse(
      JSON.parse(await files.read(`${DIRECTORY}/${entry.name}`, 65536)),
    );
    if (
      entry.name !== `${value.input.id}.json` ||
      value.fingerprint !== digest(JSON.stringify([value.input, value.source]))
    )
      throw new AppError("FEEDBACK_CORRUPT", "纠正记录身份或内容哈希不一致");
    records.push(value);
  }
  return records.sort((a, b) => a.input.id.localeCompare(b.input.id));
}
/** 范围与词语用于筛选；同主题较新表述不自动推翻旧规则，替代必须有显式链。 */
export async function feedbackContext(
  files: ProjectFiles,
  query = "",
  paths: string[] = [],
) {
  const all = await feedbackRecords(files),
    replaced = new Set(
      all.flatMap((item) =>
        item.input.supersedes_id ? [item.input.supersedes_id] : [],
      ),
    ),
    terms = queryTerms(query);
  const active = all
    .filter(
      (item) =>
        !replaced.has(item.input.id) &&
        item.input.status !== "disabled" &&
        item.input.audience !== "task",
    )
    .filter(
      (item) =>
        !item.input.paths.length ||
        !paths.length ||
        paths.some((path) =>
          item.input.paths.some((pattern) => matchesPath(pattern, path)),
        ),
    )
    .map((item) => ({
      item,
      score: terms.filter((term) =>
        [item.input.rule, ...item.input.conditions]
          .join(" ")
          .toLowerCase()
          .includes(term),
      ).length,
    }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.item.recorded_at.localeCompare(a.item.recorded_at),
    );
  const version = digest(
    JSON.stringify(
      active
        .map(({ item }) => [item.input.id, item.fingerprint])
        .sort((a, b) => a[0]!.localeCompare(b[0]!)),
    ),
  );
  return {
    version,
    items: active
      .slice(0, 20)
      .map(({ item }) => ({
        ...item,
        effective: false,
        condition_check: "required",
      })),
    truncated: active.length > 20,
    limitation:
      "即时纠正是带用户原话的候选；按当前需求核对条件，不自动确认团队规则。不依赖活跃任务，后台不会自动分析剩余历史。",
  };
}
