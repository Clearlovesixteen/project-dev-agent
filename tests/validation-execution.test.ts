import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { readFile, writeFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { bindWorktree } from "../src/git/index.js";
import { TaskService } from "../src/task-service.js";
import { TaskSchema } from "../src/domain/task.js";
import { runValidation } from "../src/quality/validation-runner.js";
import { createGitFixture } from "./helpers/create-git-fixture.js";
import { withImplementationBasis } from "./helpers/implementation-basis.js";
const execute = promisify(execFile);
async function setup(t: {after(action: () => Promise<void>): void}, code = "console.log('检查确实执行');", timeout_ms = 10000) {
  const fixture = await createGitFixture(); t.after(fixture.cleanup);
  const binding = await bindWorktree(fixture.path), service = new TaskService(binding);
  const request = await withImplementationBasis(fixture.path, { requirement: "验证真实执行结果", acceptance_criteria: [{id: "behavior", description: "核对当前业务改动"}] });
  const task = TaskSchema.parse((await service.open({...request, validation_plan: {checks: [{id:"syntax", description:"运行本次计划", command:"node", args:["-e", code], timeout_ms, acceptance_ids:["behavior"]}]}})).data);
  await writeFile(join(fixture.path,"src/new-business.js"), "// 业务入口沿用既有职责边界。\nexport const entry = 1;\n");
  return {fixture,binding,service,task};
}
async function close(service: TaskService, task: any) {
  const checked = (await service.check({})).data as any;
  const review = {status:"checked", reviewed_by:"fixture", evidence:[{kind:"manual",reference:"src/new-business.js",summary:"人工检查当前职责与代码"}]};
  return service.update({task_id:task.id,expected_revision:task.revision,phase:"closed",review_snapshot:checked.review_snapshot,
    acceptance_criteria:task.acceptance_criteria.map((item:any)=>({...item,...review})),
    change_items:checked.changed_paths.map((path:string,index:number)=>({id:`change-${index}`,target_path:path,action:"modify",requirement:"当前改动",rationale:"明确涉及本次需求",sources:[{kind:"code",reference:path}],...review})),
    validations:[{id:"fake",description:"调用方自报不能替代运行",outcome:"passed",evidence:review.evidence}]});
}

test("真实检查未运行时，自报 passed 和完整验收不能关闭生产代码任务", async t => {
  const {service,task}=await setup(t);
  assert.equal((await close(service,task)).code,"VALIDATION_RUN_REQUIRED");
  const execution=((await service.check({})).data as any).quality.execution;
  assert.equal(execution.checks[0].state,"not_run");
});
test("CLI 执行器实际运行并保存真实退出码，MCP 可核对并用于关闭", async t => {
  const {fixture,service,task}=await setup(t);
  const cli=fileURLToPath(new URL("../src/cli.js",import.meta.url));
  const env={...process.env};delete env.NODE_TEST_CONTEXT;
  const result=JSON.parse((await execute(process.execPath,[cli,"validation","run","--project",fixture.path,"--task-id",task.id,"--check-id","syntax"],{env})).stdout);
  assert.equal(result.code,"VALIDATION_PASSED"); assert.equal(result.data.exit_code,0);assert.match(result.data.output,/检查确实执行/);
  const saved=JSON.parse(await readFile(result.data.log_reference,"utf8"));assert.equal(saved.id,result.data.id);
  assert.equal(((await service.check({})).data as any).quality.execution.state,"checked");
  assert.equal((await close(service,task)).outcome,"ok");
});
test("非零退出、超时与启动失败如实保留，不能通过任务验收",async t=>{
  for(const [code,state,timeout] of [["process.exit(7)","failed",10000],["setTimeout(()=>{},10000)","timed_out",100]] as const){
    const {binding,service,task}=await setup(t,code,timeout);const result=await runValidation(binding,task.id,"syntax");
    assert.equal(result.data.state,state);assert.equal((await close(service,task)).code,"VALIDATION_RUN_REQUIRED");
  }
  const {binding,service,task}=await setup(t);
  const update=await service.update({task_id:task.id,expected_revision:0,validation_plan:{checks:[{...task.validation_plans![0]!.plan.checks[0],command:"missing-project-dev-executable"}]}});
  assert.equal(update.outcome,"ok");const result=await runValidation(binding,task.id,"syntax");assert.equal(result.data.state,"start_failed");
});
test("检查期间代码变化，即使进程退出0也不能绑定旧快照",async t=>{
  const {binding,service,task}=await setup(t,"require('fs').writeFileSync('src/new-business.js','export const changed = 2;');");
  const result=await runValidation(binding,task.id,"syntax");assert.equal(result.data.exit_code,0);assert.equal(result.data.state,"stale");
  assert.equal(((await service.check({})).data as any).quality.execution.checks[0].state,"stale");
});
test("脚本声明变化使计划失效，保留计划ID修订并重跑才重新通过",async t=>{
  const {fixture,binding,service,task}=await setup(t);
  await runValidation(binding,task.id,"syntax");
  const path=join(fixture.path,"package.json"),pkg=JSON.parse(await readFile(path,"utf8"));pkg.scripts.test="node --test --test-reporter=tap";await writeFile(path,JSON.stringify(pkg));
  await assert.rejects(runValidation(binding,task.id,"syntax"),{code:"VALIDATION_PLAN_STALE"});
  assert.equal(((await service.check({})).data as any).quality.execution.checks[0].state,"plan_stale");
  const update=await service.update({task_id:task.id,expected_revision:0,validation_plan:task.validation_plans![0]!.plan});assert.equal(update.outcome,"ok");
  await runValidation(binding,task.id,"syntax");assert.equal(((await service.check({})).data as any).quality.execution.state,"checked");
  assert.equal((await service.update({task_id:task.id,expected_revision:1,validation_plan:{checks:[],not_applicable_reason:"不能通过删除既有检查跳过本次验证"}})).code,"VALIDATION_PLAN_REMOVAL");
});
test("日志有界且完整输出哈希可追溯，不把截断日志伪装为全部输出",async t=>{
  const {binding,task}=await setup(t,"process.stdout.write('a'.repeat(50000));");
  const result=await runValidation(binding,task.id,"syntax");assert.equal(result.data.output_truncated,true);assert.ok(result.data.output.length<=16000);
  const {digest}=await import("../src/knowledge/document.js");assert.equal(result.data.output_sha256,digest("a".repeat(50000)));
});
test("检查工作目录不能越界或通过链接进入仓库外部",async t=>{
  const {fixture,service,task}=await setup(t);await symlink(fixture.root,join(fixture.path,"outside"));
  const plan=task.validation_plans![0]!.plan;
  assert.equal((await service.update({task_id:task.id,expected_revision:0,validation_plan:{checks:[{...plan.checks[0],cwd:"../outside"}]}})).code,"INVALID_INPUT");
  assert.equal((await service.update({task_id:task.id,expected_revision:0,validation_plan:{checks:[{...plan.checks[0],cwd:"outside"}]}})).code,"PATH_UNSAFE");
});

test("生产 HTML 或未识别源码后缀不能当成纯文档跳过检查",async t=>{
  const {fixture,service,task}=await setup(t);
  const path=join(fixture.path,".project-dev/local/tasks",`${task.id}.json`),stored=JSON.parse(await readFile(path,"utf8"));stored.validation_plans=[];
  await writeFile(path,JSON.stringify(stored));
  await writeFile(join(fixture.path,"src/view.html"),"<script>window.app = true;</script>");
  const check=((await service.check({})).data as any).quality.execution;assert.equal(check.state,"missing");
  const {productionPath}=await import("../src/quality/validation-review.js");assert.equal(productionPath("src/new.customlang"),true);assert.equal(productionPath("README.md"),false);
});
test("脱离进程组的后代持有管道时，超时仍在硬截止后返回失败",async t=>{
  const code="require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},7000)'],{detached:true,stdio:['ignore',1,2]}).unref();";
  const {binding,task}=await setup(t,code,100),started=Date.now();
  const result=await runValidation(binding,task.id,"syntax");assert.equal(result.data.state,"timed_out");assert.ok(Date.parse(result.data.finished_at)-Date.parse(result.data.started_at)<4500,"不能等待后代自然退出才结束超时");
});
test("真实运行已有业务测试，不能继承父测试上下文而静默跳过",async t=>{
  const {binding,service,task}=await setup(t);
  const plan=task.validation_plans![0]!.plan;
  assert.equal((await service.update({task_id:task.id,expected_revision:0,validation_plan:{checks:[{...plan.checks[0],args:["--test"]}]}})).outcome,"ok");
  const result=await runValidation(binding,task.id,"syntax");assert.equal(result.data.state,"passed");assert.match(result.data.output,/# pass [1-9]/);
});

test("task_update 不能引用不存在或失败的运行记录冒充通过",async t=>{
  const {binding,service,task}=await setup(t,"process.exit(9)");
  const snapshot=((await service.check({})).data as any).review_snapshot;
  const input={task_id:task.id,expected_revision:0,review_snapshot:snapshot,validations:[{id:"proof",run_id:"invented",description:"运行证明",outcome:"passed",evidence:[{kind:"test",reference:"invented",summary:"伪造的运行ID"}]}]};
  assert.equal((await service.update(input)).code,"VALIDATION_RUN_INVALID");
  const run=await runValidation(binding,task.id,"syntax");
  assert.equal((await service.update({...input,validations:input.validations.map(item=>({...item,run_id:run.data.id}))})).code,"VALIDATION_RUN_INVALID");
});

test("并发检查不能用较快的成功掩盖仍在运行或最后失败的检查，死亡旧记录可恢复", async t => {
  const code = "const fs=require('fs'); const marker='.project-dev/local/concurrent-first'; if(!fs.existsSync(marker)){fs.writeFileSync(marker,'started'); const timer=setInterval(()=>{if(fs.existsSync(marker+'-release')){clearInterval(timer);process.exit(7);}},20);} else process.exit(0);";
  const {fixture,binding,service,task}=await setup(t,code);
  const first=runValidation(binding,task.id,"syntax");
  const marker=join(fixture.path,".project-dev/local/concurrent-first");
  for(let attempt=0;;attempt++){
    try { await readFile(marker);break; } catch { if(attempt>=200) throw new Error("首个检查未启动"); await new Promise(resolve=>setTimeout(resolve,20)); }
  }
  const second=await runValidation(binding,task.id,"syntax");assert.equal(second.data.state,"passed");
  assert.equal(((await service.check({})).data as any).quality.execution.checks[0].state,"unfinished");
  assert.equal((await close(service,task)).code,"VALIDATION_RUN_REQUIRED");
  await writeFile(marker+"-release","continue");assert.equal((await first).data.state,"failed");
  assert.equal(((await service.check({})).data as any).quality.execution.checks[0].state,"failed");
  // 进程已确认死亡的中断启动事实仍保留，新结果可恢复，但未重跑不能视为成功。
  const old={id:"interrupted",task_id:task.id,check_id:"syntax",plan_version:task.validation_plans![0]!.version,started_at:new Date().toISOString(),pid:2_147_483_647};
  await writeFile(join(fixture.path,".project-dev/local/validation",task.id,"interrupted.running"),JSON.stringify(old));
  assert.equal(((await service.check({})).data as any).quality.execution.checks[0].state,"unfinished");
  assert.equal((await runValidation(binding,task.id,"syntax")).data.state,"passed");
  assert.equal(((await service.check({})).data as any).quality.execution.state,"checked");
});

test("契约内大量需转义参数和输出仍能读取真实结果", async t => {
  const {binding,service,task}=await setup(t);
  const check=task.validation_plans![0]!.plan.checks[0]!;
  const args=["-e","process.stdout.write(String.fromCharCode(1).repeat(16000))",...Array.from({length:38},()=>"\u0001".repeat(2000))];
  assert.equal((await service.update({task_id:task.id,expected_revision:0,validation_plan:{checks:[{...check,args}]}})).outcome,"ok");
  const result=await runValidation(binding,task.id,"syntax");assert.equal(result.data.state,"passed");
  assert.ok((await readFile(result.data.log_reference)).length>256000);
  assert.equal(((await service.check({})).data as any).quality.execution.state,"checked");
});
