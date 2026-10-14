import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { AppError } from "../domain/error.js";
import { hasCode } from "../storage/project-files.js";
import { digest } from "../knowledge/document.js";
import type { HistoryMessage } from "./contracts.js";

const MAX_LINE = 8_000_000;
const MAX_VISIBLE_TEXT = 12_000_000;
const MAX_FILES = 20_000;
type RecordValue = Record<string, unknown>;
function object(value: unknown): RecordValue { return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {}; }
function string(value: unknown): string { return typeof value === "string" ? value : ""; }
export interface SessionFile { path: string; relative: string; size: number; mtime: number }
export interface SessionMeta { id: string; cwd: string; internal: boolean }
export interface ParsedSession {
  messages: HistoryMessage[]; user_messages: number; assistant_messages: number; attachment_messages: number;
  metadata_messages_excluded: number; duplicate_messages_excluded: number; redactions: number;
  diagnostics: { code: string; message: string }[];
}

/** Stream snapshots, including huge tool/compaction records, without loading entire logs. */
async function* lines(file: SessionFile): AsyncGenerator<{ text: string; line: number; oversized: boolean }> {
  const handle = await open(file.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new AppError("HISTORY_SOURCE_UNSAFE", "History source must be a regular file");
    const buffer = Buffer.alloc(64 * 1024);
    let position = 0, line = 1, bytes = 0, oversized = false;
    let pieces: Buffer[] = [];
    while (position < file.size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, file.size - position), position);
      if (!bytesRead) break;
      position += bytesRead;
      let start = 0;
      for (let index = 0; index < bytesRead; index++) {
        if (buffer[index] !== 10) continue;
        const part = buffer.subarray(start, index);
        bytes += part.length;
        if (bytes <= MAX_LINE) pieces.push(Buffer.from(part)); else oversized = true;
        yield { text: Buffer.concat(pieces).toString("utf8"), line, oversized };
        line++; bytes = 0; oversized = false; pieces = []; start = index + 1;
      }
      const tail = buffer.subarray(start, bytesRead);
      bytes += tail.length;
      if (bytes <= MAX_LINE) pieces.push(Buffer.from(tail)); else oversized = true;
    }
    if (bytes) yield { text: Buffer.concat(pieces).toString("utf8"), line, oversized };
    const after = await handle.stat();
    if (after.size < file.size || (after.size === file.size && after.mtimeMs !== file.mtime)) {
      throw new AppError("HISTORY_SOURCE_CHANGED", "A history file was rewritten while scanning; retry the scan");
    }
  } finally { await handle.close(); }
}

export async function discoverSessions(home: string): Promise<{ files: SessionFile[]; diagnostics: ParsedSession["diagnostics"] }> {
  const files: SessionFile[] = [], diagnostics: ParsedSession["diagnostics"] = [];
  let visited = 0;
  async function walk(directory: string, depth: number): Promise<void> {
    if (++visited > MAX_FILES || depth > 8) throw new AppError("HISTORY_INVENTORY_LIMIT", "History inventory exceeds 20,000 entries or eight directory levels");
    const info = await lstat(directory);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new AppError("HISTORY_SOURCE_UNSAFE", "History directories must not be symbolic links");
    for await (const entry of await opendir(directory)) {
      if (++visited > MAX_FILES) throw new AppError("HISTORY_INVENTORY_LIMIT", "History inventory exceeds 20,000 entries");
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) { diagnostics.push({ code: "HISTORY_SOURCE_UNSAFE", message: `Skipped symbolic history entry ${relative(home, path)}` }); continue; }
      if (entry.isDirectory()) await walk(path, depth + 1);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        const stat = await lstat(path);
        files.push({ path, relative: relative(home, path).split(sep).join("/"), size: stat.size, mtime: stat.mtimeMs });
      }
    }
  }
  for (const name of ["sessions", "archived_sessions"]) {
    try { await walk(join(home, name), 0); } catch (error) {
      if (hasCode(error, "ENOENT")) continue;
      diagnostics.push({ code: "HISTORY_DIRECTORY_UNAVAILABLE", message: `${name}: ${error instanceof Error ? error.message : String(error)}` });
    }
  }
  return { files: files.sort((a, b) => a.relative.localeCompare(b.relative)), diagnostics };
}

export async function sessionMeta(file: SessionFile): Promise<SessionMeta> {
  for await (const line of lines(file)) {
    if (line.oversized) break;
    const record = object(JSON.parse(line.text));
    if (record.type !== "session_meta") break;
    const payload = object(record.payload);
    const id = string(payload.id) || string(payload.session_id);
    const cwd = string(payload.cwd);
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id) || !isAbsolute(cwd)) break;
    return { id, cwd, internal: Boolean(object(payload.source).subagent) || /subagent|review|guardian/i.test(JSON.stringify(payload.thread_source ?? "")) };
  }
  throw new AppError("HISTORY_METADATA_UNKNOWN", `Cannot attribute ${file.relative} from its session metadata`);
}

/** Exact repository ancestry only. Mentioning a project in another chat is not attribution. */
export async function belongsToProject(cwd: string, project: string): Promise<boolean> {
  let canonical = resolve(cwd);
  try { canonical = await realpath(canonical); } catch (error) { if (!hasCode(error, "ENOENT")) throw error; }
  const part = relative(project, canonical);
  if (isAbsolute(part) || part === ".." || part.startsWith(`..${sep}`)) return false;
  let current = project;
  for (const segment of part.split(sep).filter(Boolean)) {
    current = join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) return false;
      await lstat(join(current, ".git"));
      return false; // Nested repositories have their own history.
    } catch (error) { if (!hasCode(error, "ENOENT")) throw error; }
  }
  return true;
}

export async function historyHome(configured: string): Promise<string> {
  const home = resolve(configured);
  const info = await lstat(home);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new AppError("HISTORY_SOURCE_UNSAFE", "Codex history home must be a real directory");
  return realpath(home);
}

export function redact(text: string): { text: string; count: number } {
  let count = 0;
  const patterns = [
    /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,
    /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{16,})\b/g,
    /\bBearer\s+[A-Za-z0-9._~+\/-]{12,}/gi,
    /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|authorization)["']?\s*[:=]\s*["']?)[^\s"'&,;}]{8,}/gi,
  ];
  for (const pattern of patterns) text = text.replace(pattern, (...args: unknown[]) => {
    count++; return typeof args[1] === "string" ? `${args[1]}[REDACTED]` : "[REDACTED]";
  });
  return { text, count };
}

function cleanBlock(raw: string): { text: string; context: string; attachment: boolean } {
  let text = raw.trim(), context = "";
  const attachment = /<image\b|# Files mentioned by the user:|<file\b/.test(text);
  if (/^<send_user_message_question_reply>/.test(text)) {
    try {
      const replies: unknown = JSON.parse(text.replace(/^<send_user_message_question_reply>\s*/, "").replace(/\s*<\/send_user_message_question_reply>$/, ""));
      if (Array.isArray(replies)) {
        context = replies.map((reply) => string(object(reply).question)).filter(Boolean).join("\n");
        text = replies.map((reply) => string(object(reply).answer)).filter(Boolean).join("\n");
      }
    } catch { text = ""; }
  } else {
    if (/^(?:# AGENTS\.md instructions|<user_instructions>|<environment_context>|<recommended_plugins>|<skills_instructions>|<permissions|<external_codex_apps_open_page>|<turn_aborted>|<INSTRUCTIONS>|<subagent_notification>|<agent_message>)/i.test(text)) text = "";
    if (text.includes("## My request:")) text = text.slice(text.indexOf("## My request:") + "## My request:".length).trim();
    if (/^<\/?image\b|^<\/?file\b/i.test(text)) text = "";
  }
  return { text, context, attachment };
}

export async function parseSession(file: SessionFile, meta: SessionMeta, project: string): Promise<ParsedSession> {
  const result: ParsedSession = { messages: [], user_messages: 0, assistant_messages: 0, attachment_messages: 0,
    metadata_messages_excluded: 0, duplicate_messages_excluded: 0, redactions: 0, diagnostics: [] };
  const seen = new Set<string>();
  const mirror = new Map<string, { origin: string; line: number; turn: string }>();
  let cwd = meta.cwd, turn = "", visible = 0;
  const add = (role: "user" | "assistant", text: string, record: RecordValue, payload: RecordValue, line: number, origin: string) => {
    if (!text.trim()) return;
    const explicitId = string(payload.id);
    const identity = explicitId ? `${role}:${explicitId}:${digest(text)}` : `${role}:${line}:${digest(text)}`;
    const mirrored = mirror.get(`${role}:${digest(text)}`);
    if (seen.has(identity) || (mirrored && mirrored.origin !== origin && mirrored.turn === turn && line - mirrored.line < 8)) {
      result.duplicate_messages_excluded++; return;
    }
    seen.add(identity); mirror.set(`${role}:${digest(text)}`, { origin, line, turn });
    const safe = redact(text);
    result.redactions += safe.count;
    visible += safe.text.length;
    if (visible > MAX_VISIBLE_TEXT) throw new AppError("HISTORY_TEXT_LIMIT", "A session exceeds 12 million visible text characters");
    const parts = Math.ceil(safe.text.length / 3_000);
    for (let part = 0; part < parts; part++) result.messages.push({
      id: `msg-${digest(`${meta.id}:${identity}`).slice(0, 24)}-${part + 1}`, role, text: safe.text.slice(part * 3_000, (part + 1) * 3_000),
      session: meta.id, file: file.relative, line, timestamp: string(record.timestamp), part: part + 1, parts,
    });
    result[role === "user" ? "user_messages" : "assistant_messages"]++;
  };
  for await (const line of lines(file)) {
    if (line.oversized) {
      // Huge compaction and tool output records are outside the visible-dialogue contract.
      if (!/"type"\s*:\s*"(?:compacted|world_state|function_call_output|custom_tool_call_output|reasoning)"/.test(line.text.slice(0, 1_024))) {
        result.diagnostics.push({ code: "HISTORY_LINE_LIMIT", message: `${file.relative}:${line.line} exceeds 8 MB and could not be analyzed` });
      }
      continue;
    }
    let record: RecordValue;
    try { record = object(JSON.parse(line.text)); } catch {
      result.diagnostics.push({ code: "HISTORY_INVALID_RECORD", message: `${file.relative}:${line.line} is incomplete or invalid JSON` }); continue;
    }
    const payload = object(record.payload);
    if (record.type === "turn_context") { cwd = string(payload.cwd) || cwd; turn = string(payload.turn_id) || turn; continue; }
    if (record.type === "event_msg" && payload.type === "task_started") { turn = string(payload.turn_id) || turn; continue; }
    const response = record.type === "response_item" && payload.type === "message";
    const event = record.type === "event_msg" && payload.type === "user_message";
    if (!response && !event) continue;
    const role = event ? "user" : payload.role;
    if (role !== "user" && role !== "assistant") continue;
    if (payload.channel === "analysis" || payload.channel === "summary" || payload.phase === "summary") continue;
    if (!await belongsToProject(cwd, project)) continue;
    if (role === "assistant") {
      const blocks = Array.isArray(payload.content) ? payload.content : [];
      add(role, blocks.map((block) => object(block).type === "output_text" ? string(object(block).text) : "").filter(Boolean).join("\n"), record, payload, line.line, "response");
      continue;
    }
    const blocks = event ? [string(payload.message)] : (Array.isArray(payload.content) ? payload.content : [])
      .filter((block) => object(block).type === "input_text").map((block) => string(object(block).text));
    const cleaned = blocks.map(cleanBlock);
    if (cleaned.some((block) => block.attachment) || (Array.isArray(payload.content) && payload.content.some((block) => /image|file/.test(string(object(block).type))))) result.attachment_messages++;
    const text = cleaned.map((block) => block.text).filter(Boolean).join("\n");
    const context = cleaned.map((block) => block.context).filter(Boolean).join("\n");
    if (!text) { result.metadata_messages_excluded++; continue; }
    if (context) add("assistant", context, record, { id: `${string(payload.id)}-question` }, line.line, "question_context");
    add("user", text, record, payload, line.line, event ? "event" : "response");
  }
  return result;
}
