import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createGitFixture } from "./helpers/create-git-fixture.js";
import { withImplementationBasis } from "./helpers/implementation-basis.js";
import { ruleFingerprint } from "../src/understanding/model-evidence.js";
import { digest } from "../src/knowledge/document.js";
const execute = promisify(execFile);

test("真实发布运行文件贯通：草案、终端执行、场景验收、模型回写和重启关闭", async t => {
  const fixture = await createGitFixture(); t.after(fixture.cleanup);
  const runtime = fileURLToPath(new URL("../../plugins/project-dev-agent/runtime/cli.mjs", import.meta.url));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string,string] => entry[1] !== undefined)); delete env.NODE_TEST_CONTEXT;
  const connect = async () => { const client = new Client({name:"development-lifecycle",version:"1"}); t.after(()=>client.close());
    await client.connect(new StdioClientTransport({command:process.execPath,args:[runtime,"serve","--project",fixture.path],env,stderr:"pipe"})); return client; };
  const first = await connect();
  const call = async (client:Client,name:string,args:Record<string,unknown>={}) => (await client.callTool({name,arguments:args})).structuredContent as any;
  assert.equal((await call(first,"project_scan")).code,"PROJECT_SCANNED");
  const original = await readFile(join(fixture.path,"src/service.js"),"utf8"), lines=original.split("\n"), line=lines.findIndex(value=>value.includes('INVALID_ACCOUNT_ID'))+1;
  const oldRule={id:"id-valid",description:"账户ID不能为空白",basis:"observed",responsibility:"backend",conditions:["创建账户时"],exceptions:[],source_ids:["old-code"]};
  const scanned=(await call(first,"project_context",{paths:["src/service.js"]})).data;
  assert.equal((await call(first,"project_model_record",{id:"accounts",schema_version:2,scan_id:scanned.scan_id,expected_revision:0,revision_reason:"核对原账户ID校验",module:"src",title:"账户ID",scope:["src/service.js"],summary:"账户创建输入约束",entities:[],flows:[],questions:[],related_paths:["src/service.js"],relations:[],rules:[oldRule],sources:[{id:"old-code",kind:"code",path:"src/service.js",sha256:digest(original),line,quote:lines[line-1]}]})).code,"PROJECT_MODEL_RECORDED");
  const input=await withImplementationBasis(fixture.path,{requirement:"账户ID去除空白后至少2个字符。",acceptance_criteria:[{id:"normal",description:"有效ID创建成功"},{id:"boundary",description:"单字符和空白ID均拒绝"}]});
  let task=(await call(first,"task_open",input)).data;
  const proposed={...oldRule,description:"账户ID去除空白后至少2个字符",basis:"intended",source_ids:["request"]};
  let result=await call(first,"task_update",{task_id:task.id,expected_revision:task.revision,business_deltas:[{id:"id-length",model_id:"accounts",base_revision:1,operation:"modify",rule_id:oldRule.id,expected_rule_fingerprint:ruleFingerprint(oldRule as any),reason:"实现本次ID长度要求",acceptance_ids:["normal","boundary"],proposed_rule:proposed,sources:[{id:"request",kind:"task",task_id:task.id,quote:task.requirement}]}]});
  assert.equal(result.code,"TASK_UPDATED");task=result.data;
  const before=(await call(first,"project_context",{model_id:"accounts"})).data.models[0];assert.equal(before.rules[0].description,oldRule.description);
  const changed=original.replace('!id.trim()', 'id.trim().length < 2');await writeFile(join(fixture.path,"src/service.js"),changed);
  await writeFile(join(fixture.path,"tests/id-length.test.js"),"import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport {createAccountSystem} from '../src/system.js';\ntest('单字符和空白ID拒绝，有效ID通过',()=>{ const {service}=createAccountSystem(); for(const id of ['a','  ']) assert.throws(()=>service.createAccount({id,email:'a@b'}),/INVALID_ACCOUNT_ID/); assert.equal(service.createAccount({id:'ab',email:'a@b'}).id,'ab'); });\n");
  await call(first,"project_scan");
  assert.equal((await call(first,"project_model_apply",{task_id:task.id,expected_revision:task.revision,delta_id:"id-length",observed_rule:{...proposed,basis:"observed",source_ids:["new-code"]},sources:[{id:"bad-code",kind:"code",path:"src/service.js",sha256:"0".repeat(64),line,quote:changed.split("\n")[line-1]}]})).outcome,"error");
  const run=JSON.parse((await execute(process.execPath,[runtime,"validation","run","--project",fixture.path,"--task-id",task.id,"--check-id","project-tests"],{env})).stdout);
  assert.equal(run.code,"VALIDATION_PASSED");assert.match(run.data.output,/单字符和空白ID/);
  const checked=(await call(first,"task_check")).data, scenarios=checked.quality.business_delta.items[0].scenarios;
  const proof=[{kind:"test",reference:run.data.log_reference,summary:"实际项目测试覆盖单字符、空白ID拒绝和有效ID创建"}];
  const review={status:"checked",reviewed_by:"fixture",evidence:proof};
  result=await call(first,"task_update",{task_id:task.id,expected_revision:task.revision,review_snapshot:checked.review_snapshot,
    acceptance_criteria:task.acceptance_criteria.map((item:any,index:number)=>({...item,...review,business_delta_check:scenarios[index].business_delta_check})),
    change_items:checked.changed_paths.map((path:string,index:number)=>({id:`change-${index}`,target_path:path,action:"modify",requirement:task.requirement,rationale:"实现ID长度规则并验证边界",sources:[{kind:"code",reference:"src/service.js"}],...review})),
    validations:[{id:"tests",description:"原项目与新增边界测试",outcome:"passed",run_id:run.data.id,evidence:proof}]});assert.equal(result.code,"TASK_UPDATED");task=result.data;
  assert.equal((await call(first,"task_update",{task_id:task.id,expected_revision:task.revision,phase:"closed"})).code,"BUSINESS_DELTA_PENDING");
  const applied=await call(first,"project_model_apply",{task_id:task.id,expected_revision:task.revision,delta_id:"id-length",observed_rule:{...proposed,basis:"observed",source_ids:["new-code"]},sources:[{id:"new-code",kind:"code",path:"src/service.js",sha256:digest(changed),line,quote:changed.split("\n")[line-1]}]});
  assert.equal(applied.code,"BUSINESS_DELTA_APPLIED",JSON.stringify(applied));await first.close();
  const second=await connect(),restored=(await call(second,"task_check")).data;
  assert.equal(restored.quality.execution.state,"checked");assert.equal(restored.quality.business_delta.state,"checked");assert.equal(restored.recorded_task.id,task.id);
  const current=(await call(second,"project_context",{model_id:"accounts"})).data.models[0];assert.equal(current.rules[0].description,proposed.description);assert.equal(current.rules[0].basis,"observed");
  assert.equal((await call(second,"task_update",{task_id:task.id,expected_revision:applied.data.revision,phase:"closed"})).outcome,"ok");
});
