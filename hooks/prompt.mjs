// 接收宿主的提示事件并返回空结果。消费 stdin 以兼容大输入，避免载入项目运行时。
process.stdin.resume();
process.stdin.once("end", () => process.stdout.write("{}\n"));
