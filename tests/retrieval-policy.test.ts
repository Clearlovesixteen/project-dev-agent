import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectFiles } from "../src/storage/project-files.js";
import { DEFAULT_CONFIG } from "../src/knowledge/config.js";
import { digest } from "../src/knowledge/document.js";
import { FileSchema, type MapFile } from "../src/understanding/contracts.js";
import { lexicalReferences } from "../src/understanding/lexical.js";
import { implementationCandidates, implementationScope, lexicalProvider } from "../src/understanding/retrieval.js";
import { createGitFixture } from "./helpers/create-git-fixture.js";
import { bindWorktree } from "../src/git/index.js";
import { UnderstandingService } from "../src/understanding/service.js";

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "implementation-retrieval-"))); t.after(() => rm(root, { recursive: true, force: true }));
  const files = new ProjectFiles(root), entries: MapFile[] = [];
  const add = async (path: string, text: string, imports: MapFile["imports"] = [], role: MapFile["role"] = "source") => {
    await files.directory(path.split("/").slice(0, -1).join("/") || "src"); await files.create(path, text);
    const entry = FileSchema.parse({ path, sha256: digest(text), bytes: Buffer.byteLength(text), module: path.split("/").slice(0, -1).join("/"), role,
      imports, imports_truncated: false, ...lexicalReferences(text) }); entries.push(entry); return entry;
  };
  return { root, files, entries, add };
}

test("按已存符号检索 camelCase/snake_case，相关实现优先于名字相近的热门文件", async t => {
  const f = await fixture(t);
  await f.add("src/platform/kernel.ts", "export function buildOrderDraft(input) { return input; }\n", [], "shared");
  await f.add("src/shared/order-draft.ts", "export const serializeOther = value => value;\n", [], "shared");
  await f.add("src/feature/alpha.ts", "import {serializeOther} from '../shared/order-draft'; serializeOther({});\n",
    [{ specifier: "../shared/order-draft", target: "src/shared/order-draft.ts", line: 1 }]);
  for (const query of ["buildOrderDraft", "build_order_draft", "order draft"]) {
    const result = await implementationCandidates(f.files, f.entries, DEFAULT_CONFIG, ["src/modules/new"], query);
    assert.equal(result.candidates[0]?.path, "src/platform/kernel.ts");
    assert.ok(result.candidates[0]?.match_reasons.some(reason => /symbol/.test(reason.kind)));
    assert.equal(result.candidates[0]?.source_state, "current"); assert.equal(result.candidates[0]?.position?.line, 1);
  }
  assert.equal(lexicalProvider.rank(f.entries[0]!, "prebuildOrderDraftSuffix").reasons.some(reason => reason.kind === "exact_symbol"), false);
});

test("全新 app 目录扩搜本应用和根级公共实现，隔离其他 app/package", async t => {
  const f = await fixture(t);
  for (const path of ["apps/wms/shared/format.ts", "apps/crm/shared/format.ts", "packages/internal/shared/format.ts", "src/shared/format.ts"]) {
    await f.add(path, "export const formatShipment = value => value;\n", [], "shared");
  }
  const result = await implementationCandidates(f.files, f.entries, DEFAULT_CONFIG, ["apps/wms/features/new"], "formatShipment");
  assert.deepEqual(result.candidates.map(item => item.path).sort(), ["apps/wms/shared/format.ts", "src/shared/format.ts"]);
  assert.equal(implementationScope("apps/crm/x.ts", ["apps/wms"]), false);
  assert.equal(implementationScope("apps/wms/x.ts", ["apps/wms"]), true);
});

test("调用样例保留真实导入、别名用法、当前 hash 和一基位置", async t => {
  const f = await fixture(t);
  await f.add("src/shared/address.ts", "export function normalizeAddress(input) { return input; }\n", [], "shared");
  const consumer = "import {unrelated} from './other';\nimport {normalizeAddress as normalize} from '../shared/address';\nexport function saveAddress(input) {\n  return normalize(input);\n}\n";
  await f.add("src/checkout/form.ts", consumer, [{ specifier: "../shared/address", target: "src/shared/address.ts", line: 2 }]);
  const result = await implementationCandidates(f.files, f.entries, DEFAULT_CONFIG, ["src/refunds/new"], "normalizeAddress");
  const item = result.candidates[0]!, example = item.consumers[0]!;
  assert.equal(item.position?.column, 17); assert.equal(example.sha256, digest(consumer)); assert.equal(example.source_state, "current");
  assert.equal(example.import_line, 2); assert.equal(example.usage?.line, 4); assert.equal(example.usage?.quote, "return normalize(input);");
  assert.equal(example.relation, "import_and_identifier");
});

test("来源修改、无法读取和被排除文件不冒充当前检索证据", async t => {
  const f = await fixture(t);
  await f.add("src/shared/address.ts", "export const normalizeAddress = value => value;\n", [], "shared");
  await f.add("src/private/address.ts", "export const normalizeAddress = value => value;\n", [], "shared");
  await f.add("src/shared/missing.ts", "export const normalizeAddress = value => value;\n", [], "shared");
  await writeFile(join(f.root, "src/shared/address.ts"), "export const normalizeAddress = value => value.trim();\n");
  await rm(join(f.root, "src/shared/missing.ts"));
  const result = await implementationCandidates(f.files, f.entries, { ...DEFAULT_CONFIG, exclude_paths: ["src/private"] }, [], "normalizeAddress");
  assert.equal(result.state, "partial"); assert.deepEqual(result.candidates.map(item => item.path), ["src/shared/address.ts"]);
  assert.equal(result.candidates[0]?.source_state, "changed"); assert.notEqual(result.candidates[0]?.sha256, result.candidates[0]?.indexed_sha256);
});

test("无词法命中降级为结构线索，容量有限且不宣称不存在其他实现", async t => {
  const f = await fixture(t);
  for (let index = 0; index < 12; index++) await f.add(`src/shared/item-${index}.ts`, `export const sharedItem${index} = value => value;\n`, [], "shared");
  const result = await implementationCandidates(f.files, f.entries, DEFAULT_CONFIG, [], "完全没有的业务词");
  assert.equal(result.state, "structural_fallback"); assert.equal(result.candidates.length, 8); assert.equal(result.truncated, true);
  assert.ok(result.candidates.every(item => item.match_reasons[0]?.kind === "structural_fallback"));
  assert.match(result.limitations, /不证明.*不存在/);
  const empty = await implementationCandidates(f.files, [], DEFAULT_CONFIG, [], "未命中"); assert.equal(empty.state, "no_index_match");
});

test("project_context 普通查询也利用符号，全新目录上下文复用同一检索", async t => {
  const f = await createGitFixture(); t.after(f.cleanup);
  await writeFile(join(f.path, "src/kernel.ts"), "export function calculateShipmentWindow(input) { return input; }\n");
  const service = new UnderstandingService(await bindWorktree(f.path)); assert.equal((await service.scan({})).outcome, "ok");
  const normal = (await service.context({ query: "calculate_shipment_window" })).data as any;
  assert.ok(normal.files.some((entry: any) => entry.path === "src/kernel.ts"));
  const added = (await service.context({ paths: ["src/modules/brand-new"], query: "calculateShipmentWindow" })).data as any;
  assert.equal(added.implementation_context.implementation_candidates.candidates[0]?.path, "src/kernel.ts");
});
