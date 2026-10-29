import { readFile, writeFile } from "node:fs/promises";
const databaseId = process.env.PROJECT_DEV_DIAGNOSTICS_DB_ID;
const workerName = process.env.PROJECT_DEV_DIAGNOSTICS_WORKER ?? "project-dev-diagnostics";
if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(databaseId ?? "")) throw new Error("请在构建环境配置有效的 PROJECT_DEV_DIAGNOSTICS_DB_ID");
if (!/^[a-z][a-z0-9-]{2,62}$/.test(workerName)) throw new Error("诊断 Worker 名称格式无效");
const source = await readFile(new URL("wrangler.example.toml", import.meta.url), "utf8");
await writeFile(new URL("wrangler.toml", import.meta.url), source.replace("REPLACE_WITH_YOUR_DATABASE_ID", databaseId)
  .replace('name = "project-dev-diagnostics"', `name = "${workerName}"`), { mode: 0o600 });
