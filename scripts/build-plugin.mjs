import { build } from "esbuild";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(root, "plugins/project-dev-agent");
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
// 完整源码依赖使用较新的 Node；同事运行的是仅包含 STDIO 所需依赖的预构建插件。
// 单独维护插件运行门槛，并用同一个版本生成编译目标、安装元数据和说明。
const runtimeNodeMinimum = "18.19.0";
const runtimeEngines = { node: `>=${runtimeNodeMinimum}` };
const manifest = JSON.parse(await readFile(join(root, "plugin.json"), "utf8"));
const versionSource = await readFile(join(root, "src/version.ts"), "utf8");
if (manifest.version !== pkg.version || !versionSource.includes(`VERSION = "${pkg.version}"`)) throw new Error("Release versions disagree");

await rm(target, { recursive: true, force: true });
await mkdir(join(target, "runtime"), { recursive: true });
const result = await build({
  absWorkingDir: root, entryPoints: ["src/cli.ts"], outfile: join(target, "runtime/cli.mjs"),
  bundle: true, platform: "node", target: `node${runtimeNodeMinimum}`, format: "esm", minify: true,
  sourcemap: false, legalComments: "eof", metafile: true,
  banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
});
const hookResult = await build({
  absWorkingDir: root, entryPoints: ["src/hooks/entry.ts"], outfile: join(target, "runtime/hooks.mjs"),
  bundle: true, platform: "node", target: `node${runtimeNodeMinimum}`, format: "esm", minify: true,
  sourcemap: false, legalComments: "eof", metafile: true,
  banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
});
// Explicit assets only: never ship work/, personal records, local configuration, or node_modules.
for (const name of ["mcp.json", "hooks", "skills", "templates", "fixtures"]) {
  await cp(join(root, name), join(target, name), { recursive: true, dereference: false });
}
// 当前桌面 CLI 的 portable manifest 能读取技能/MCP，却遗漏插件 hooks。
// 发布包采用官方仍支持的 Codex 兼容入口；不能同时放 root plugin.json，否则宿主会优先选它。
// 根目录源码 manifest 继续作为版本与元数据的唯一维护来源。
await mkdir(join(target, ".codex-plugin"), { recursive: true });
await writeFile(join(target, ".codex-plugin/plugin.json"), JSON.stringify({
  name: manifest.name, version: manifest.version, description: manifest.description,
  ...manifest.extensions["com.openai"], mcpServers: "./mcp.json",
}, null, 2) + "\n");
await writeFile(join(target, "package.json"), JSON.stringify({
  name: pkg.name, version: pkg.version, private: true, type: "module", engines: runtimeEngines,
  description: pkg.description, bin: { "project-dev-agent": "runtime/cli.mjs" },
}, null, 2) + "\n");
await writeFile(join(target, "README.md"), `# Project Dev Agent ${pkg.version}\n\n此目录是 Codex 插件发布产物，由 \`npm run build:plugin\` 生成，请修改源码后重新构建。\n\n运行环境：Node.js ${runtimeNodeMinimum}+ 和 Git。依赖已打包，无需 npm install。使用 Node 18.19+ 的业务项目可以直接使用，无需升级项目 Node。\n\n安装、更新和迁移说明：[仓库 README](https://github.com/Clearlovesixteen/project-dev-agent#readme)。\n\n直接使用 \`project-dev\` 开发，首次运行自动初始化当前 Git 仓库；需要调整工作目录或启用自动辅助时使用 \`project-dev-setup\`。原生钩子须由宿主审查信任；旧安装默认保留 manual 模式。新安装首次运行默认向维护者发送不含代码、需求或对话正文的运行诊断，可通过项目设置关闭；已有关闭和自定义配置保持原样。\n个人设置在 Codex 用户目录的 \`project-dev-agent/settings.json\`，项目记录在业务仓库的 \`.project-dev/local/\`，不会随插件升级被替换。\n`);

const dependencyRoots = new Set();
for (const input of new Set([...Object.keys(result.metafile.inputs), ...Object.keys(hookResult.metafile.inputs)])) {
  if (!input.includes("node_modules/")) continue;
  let directory = dirname(join(root, input));
  while (directory !== root) {
    try {
      const data = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
      if (data.name && data.version) { dependencyRoots.add(directory); break; }
    } catch {}
    directory = dirname(directory);
    if (directory === dirname(directory)) throw new Error(`Missing package metadata: ${input}`);
  }
}
const notices = [];
const dependencies = [];
for (const directory of [...dependencyRoots].sort()) {
  const data = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
  const names = (await readdir(directory)).filter((name) => /^(licen[sc]e|copying|notice)(\.|$)/i.test(name));
  if (!names.length) throw new Error(`Missing license notice for ${data.name}`);
  dependencies.push({ name: data.name, version: data.version, license: data.license ?? "See notice" });
  notices.push(`=== ${data.name}@${data.version} (${data.license ?? "See below"}) ===\n`);
  for (const name of names.sort()) notices.push(await readFile(join(directory, name), "utf8"));
}
await writeFile(join(target, "THIRD-PARTY-NOTICES.txt"), notices.join("\n\n") + "\n");
const files = [];
async function inventory(directory) {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Plugin assets must not be symlinks: ${path}`);
    if (entry.isDirectory()) await inventory(path);
    else {
      const bytes = await readFile(path);
      files.push({ path: relative(target, path), bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
    }
  }
}
await inventory(target);
await writeFile(join(target, "build-info.json"), JSON.stringify({ version: pkg.version, node: runtimeEngines.node, dependencies, files }, null, 2) + "\n");
console.log(JSON.stringify({ version: pkg.version, directory: relative(root, target), files: files.length + 1,
  bytes: files.reduce((sum, file) => sum + file.bytes, 0), bundled_dependencies: dependencies.length }));
