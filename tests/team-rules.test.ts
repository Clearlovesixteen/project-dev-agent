import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { join } from "node:path";
import { realpath, unlink, writeFile } from "node:fs/promises";
import { createGitFixture } from "./helpers/create-git-fixture.js";
import { withSampleGit } from "../src/sample/git-isolation.js";
import { bindWorktree } from "../src/git/index.js";
import { ProjectFiles } from "../src/storage/project-files.js";
import { publishModelShadow } from "../src/project-knowledge/service.js";
import { sourceFingerprint } from "../src/understanding/model-evidence.js";
import { digest } from "../src/domain/digest.js";
import { exportTeamRule, enableTeamRules } from "../src/knowledge/team-rule-export.js";
import { TEAM_RULE_POLICY, TeamRule } from "../src/knowledge/team-rule-contract.js";
import { reviewKnowledge } from "../src/knowledge/review.js";
import { searchKnowledge } from "../src/knowledge/search.js";

/** 真实 Git 项目内建立模型，故意为未选择的规则和模型元数据放入不可共享内容。 */
async function fixture(t: TestContext) {
  const fixture = await createGitFixture(); t.after(fixture.cleanup);
  const binding = await bindWorktree(fixture.path), files = new ProjectFiles(binding.root);
  const path = "src/auth.js", text = await files.read(path), sha256 = digest(text);
  const source = { id: "auth-code", kind: "code" as const, path, sha256, line: 1, quote: text.split("\n")[0]! };
  const rule = { id: "disable", basis: "observed", responsibility: "backend", description: "禁用账号后旧会话失效",
    conditions: ["账号已禁用"], exceptions: ["内部审计会话单独处理"], source_ids: [source.id],
    evidence_versions: [{ id: source.id, fingerprint: sourceFingerprint(source) }] };
  const model = { schema_version: 2, id: "auth", module: "account", title: "登录", scope: ["src"], related_paths: [path],
    summary: "内部会话记录不要传给同事", sources: [source], entities: [], flows: [], questions: [], relations: [],
    project: files.root, revision: 1, revision_reason: "本地聊天片段", scan_id: digest("scan"),
    recorded_at: new Date().toISOString(), related_versions: [{ path, sha256 }],
    rules: [rule, { ...rule, id: "private", description: "内部会话记录绝不导出" }] };
  await publishModelShadow(binding, model);
  const exportRule = () => exportTeamRule(files.root, "auth", "disable");
  return { fixture, binding, files, model, rule, path, text, exportRule };
}

/** 新 clone 不含原机器模型。只有审查通过的材料与本树文件匹配时才可复用。 */
test("选定单条规则经显式启用和审核后进入团队 Git，独立 clone 核验、失效和撤回", async t => {
  const f = await fixture(t);
  await assert.rejects(f.exportRule, { code: "TEAM_RULES_DISABLED" });
  const cli = async (...args: string[]) => JSON.parse((await promisify(execFile)(process.execPath,
    [fileURLToPath(new URL("../src/cli.js", import.meta.url)), ...args, "--project", f.files.root], { cwd: f.files.root })).stdout);
  await cli("team-rules", "enable");
  const draft = await cli("team-rules", "export", "--model-id", "auth", "--rule-id", "disable");
  assert.deepEqual(await f.exportRule(), draft);
  const search = async (files: ProjectFiles) => {
    const result = await searchKnowledge(files, { paths: [f.path] });
    return result.data as { results: { id: string; rule: string; effective: boolean }[]; notices: { id: string; status: string }[] };
  };
  assert.equal((await search(f.files)).results.some(item => item.id === draft.id), false);
  const reviewed = await cli("knowledge", "review", "--file", draft.file, "--reviewer", "maintainer");
  const shared = await f.files.read(reviewed.file);
  for (const privateValue of [f.files.root, "内部会话记录", "本地聊天片段", '"quote"', '"task_id"', '"evidence_versions"'])
    assert.equal(shared.includes(privateValue), false);
  assert.equal((await reviewKnowledge(f.files.root, draft.file, "maintainer")).version, reviewed.version);
  await withSampleGit(f.fixture.root, async git => {
    assert.equal(await git(f.files.root, ["rev-parse", "HEAD"]), f.fixture.head);
    await git(f.files.root, ["add", "--", TEAM_RULE_POLICY, reviewed.file]);
    await git(f.files.root, ["commit", "-m", "team-reviewed sample"]);
    const dest = join(f.fixture.root, "colleague");
    await git(f.fixture.root, ["clone", "--local", f.files.root, dest]);
    const clone = new ProjectFiles(await realpath(dest));
    const matched = (await search(clone)).results.find(item => item.id === draft.id);
    assert.equal(matched?.effective, true); assert.match(matched!.rule, /内部审计/);
    await writeFile(join(dest, f.path), f.text + "\n// 模拟另一工作树修改\n");
    assert.equal((await search(clone)).results.some(item => item.id === draft.id), false);
    assert.ok((await search(clone)).notices.some(item => item.id === draft.id && item.status === "needs_review"));
    await git(dest, ["restore", "--", f.path]);
    await unlink(join(dest, TEAM_RULE_POLICY));
    assert.equal((await search(clone)).results.some(item => item.id === draft.id), false);
    await git(dest, ["restore", "--", TEAM_RULE_POLICY]);
    await unlink(join(dest, reviewed.file));
    assert.equal((await search(clone)).results.some(item => item.id === draft.id), false);
  });
});

test("模型来源或共享修订发生变化时，旧草稿不能刷新、篡改或覆盖规则", async t => {
  const f = await fixture(t);
  await enableTeamRules(f.files.root);
  const draft = await f.exportRule(), raw = await f.files.read(draft.file), modified = JSON.parse(raw);
  modified.rule.description = "不应该发布";
  await writeFile(join(f.files.root, draft.file), JSON.stringify(modified));
  await assert.rejects(reviewKnowledge(f.files.root, draft.file, "maintainer"), { code: "TEAM_RULE_DRAFT_STALE" });
  await writeFile(join(f.files.root, draft.file), raw);
  await writeFile(join(f.files.root, f.path), f.text + "\n// change");
  await assert.rejects(reviewKnowledge(f.files.root, draft.file, "maintainer"), { code: "TEAM_RULE_MODEL_UNVERIFIED" });
  await writeFile(join(f.files.root, f.path), f.text);
  const reviewed = await reviewKnowledge(f.files.root, draft.file, "maintainer"), other = JSON.parse(await f.files.read(reviewed.file));
  other.rule.description = "同一文件的其他团队修订";
  await writeFile(join(f.files.root, reviewed.file), JSON.stringify(other));
  await assert.rejects(reviewKnowledge(f.files.root, draft.file, "maintainer"), { code: "TEAM_RULE_REVIEW_CONFLICT" });
});

test("相对文件仍匹配但本树的同一模型解释已变时，保留原因并撤去有效标记", async t => {
  const f = await fixture(t);
  await enableTeamRules(f.files.root);
  const draft = await f.exportRule();
  await reviewKnowledge(f.files.root, draft.file, "maintainer");
  const changed = { ...f.rule, exceptions: ["所有会话都终止"] };
  await publishModelShadow(f.binding, { ...f.model, revision: 2, rules: [changed] });
  const result = await searchKnowledge(f.files, { paths: [f.path], include_unconfirmed: true });
  const data = result.data as { results: { id: string; status: string; effective: boolean; source_status: { message?: string }[] }[] };
  const match = data.results.find(item => item.id === draft.id);
  assert.equal(match?.effective, false); assert.equal(match?.status, "needs_review");
  assert.ok(match.source_status.some(item => item.message?.includes("差异")));
});

test("共享字段拒绝本机数据，个人模型与不属于本项目的记录都不会被当成团队规则", async t => {
  const f = await fixture(t);
  await enableTeamRules(f.files.root);
  const draft = await f.exportRule(), reviewed = await reviewKnowledge(f.files.root, draft.file, "maintainer");
  const record = JSON.parse(await f.files.read(reviewed.file));
  for (const description of ["联系 person@example.com", "本地目录 /Users/person/secret", "文件 C:\\Users\\person\\secret"])
    assert.equal(TeamRule.safeParse({ ...record.rule, description }).success, false);
  assert.equal(TeamRule.safeParse({ ...record.rule, transcript: "private" }).success, false);
  // 即使文件内容哈希相符，错误的定位仍应按候选展示。
  const broken = { ...record, rule: { ...record.rule, sources: record.rule.sources.map((anchor: object) => ({ ...anchor, symbol: "missingSymbol" })) } };
  await writeFile(join(f.files.root, reviewed.file), JSON.stringify(broken));
  const mismatch = await searchKnowledge(f.files, { paths: [f.path], include_unconfirmed: true });
  const candidate = (mismatch.data as { results: { id: string; status: string; source_status: { message?: string }[] }[] }).results.find(item => item.id === draft.id);
  assert.equal(candidate?.status, "needs_review"); assert.ok(candidate.source_status.some(source => source.message?.includes("符号")));
  await writeFile(join(f.files.root, reviewed.file), JSON.stringify(record));
  // 模拟导入另一仓库的启用标记：记录不能在本仓库生效。
  await writeFile(join(f.files.root, TEAM_RULE_POLICY), JSON.stringify({ schema_version: 1, project_key: "2ed2a75b-ba94-48da-8442-560ec482e29c" }));
  const result = await searchKnowledge(f.files, { paths: [f.path], include_unconfirmed: true });
  assert.ok(result.diagnostics.some(item => item.message.includes("不一致")));
  assert.equal((result.data as { results: { id: string }[] }).results.some(item => item.id === draft.id), false);
});
