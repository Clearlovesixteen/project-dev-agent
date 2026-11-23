import { constants } from "node:fs";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { basename, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// 仅由隔离的钩子子进程预加载。只延迟本地诊断事件追加，设置、锁和项目文件照常访问。
const open = fs.open;
fs.open = async (path, flags, mode) => {
  if (typeof path === "string" && /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(basename(path))
      && typeof flags === "number" && (flags & constants.O_APPEND) !== 0) {
    await fs.writeFile(join(process.env.CODEX_HOME!, "slow-append-observed"), "1");
    await delay(120);
  }
  return open(path, flags, mode);
};
syncBuiltinESMExports();
