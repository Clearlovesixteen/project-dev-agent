/** 插件控制的 Node 测试报告器。只采用测试运行器事件，测试打印的 TAP/JSON 不会被当作结果。 */
export default async function* behaviorReporter(events: AsyncIterable<{ type: string; data: Record<string, unknown> }>) {
  let count = 0;
  for await (const event of events) {
    if (!["test:pass", "test:fail"].includes(event.type)) continue;
    const data = event.data;
    if (typeof data.name !== "string" || typeof data.file !== "string") continue;
    const details = data.details as { type?: string } | undefined;
    // Node 会给没有测试的文件生成通过事件，测试套件标题也会通过。两者都不能当命名场景。
    if (data.name === data.file || details?.type === "suite") continue;
    if (++count > 1000) { yield JSON.stringify({ kind: "overflow" }) + "\n"; return; }
    yield JSON.stringify({ kind: "case", name: data.name, file: data.file,
      state: data.skip ? "skipped" : data.todo ? "todo" : event.type === "test:pass" ? "passed" : "failed" }) + "\n";
  }
  yield JSON.stringify({ kind: "complete", count }) + "\n";
}
