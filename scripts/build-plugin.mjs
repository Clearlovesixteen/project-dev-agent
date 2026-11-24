import { build } from "esbuild";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const modelReader = process.argv.includes("--model-reader");
const target = join(root, modelReader ? "work/release/model-reader/project-dev-agent" : "plugins/project-dev-agent");
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
// 完整源码依赖使用较新的 Node；同事运行的是仅包含 STDIO 所需依赖的预构建插件。
// 单独维护插件运行门槛，并用同一个版本生成编译目标、安装元数据和说明。
const runtimeNodeMinimum = "18.19.0";
const runtimeEngines = { node: `>=${runtimeNodeMinimum}` };
const manifest = JSON.parse(await readFile(join(root, "plugin.json"), "utf8"));
const versionSource = await readFile(join(root, "src/version.ts"), "utf8");
if (manifest.version !== pkg.version || !versionSource.includes(`VERSION = "${pkg.version}"`)) throw new Error("Release versions disagree");

await rm(target, { recursive: true, force: true });
const runtimeBuild = join(target, ".runtime-build");
await mkdir(runtimeBuild, { recursive: true });
const result = await build({
  absWorkingDir: root, entryPoints: ["src/cli.ts"], outfile: join(runtimeBuild, "cli.mjs"),
  bundle: true, platform: "node", target: `node${runtimeNodeMinimum}`, format: "esm", minify: true,
  sourcemap: false, legalComments: "eof", metafile: true,
  define: { PROJECT_DEV_AGENT_MODEL_WRITES: String(!modelReader) },
  banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
});
const hookResult = await build({
  absWorkingDir: root, entryPoints: ["src/hooks/entry.ts"], outfile: join(runtimeBuild, "hooks.mjs"),
  bundle: true, platform: "node", target: `node${runtimeNodeMinimum}`, format: "esm", minify: true,
  sourcemap: false, legalComments: "eof", metafile: true,
  banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
});
await build({ absWorkingDir: root, entryPoints: ["src/quality/behavior-reporter.ts"],
  outfile: join(runtimeBuild, "behavior-reporter.mjs"), bundle: true, platform: "node", target: `node${runtimeNodeMinimum}`, format: "esm", minify: true, sourcemap: false });
const symbolResult = await build({ absWorkingDir: root, entryPoints: ["src/understanding/symbol-index.ts"],
  outfile: join(runtimeBuild, "symbol-index.mjs"), bundle: true, platform: "node", target: `node${runtimeNodeMinimum}`, format: "esm",
  minify: true, sourcemap: false, legalComments: "eof", metafile: true });

// Git marketplace 的 partial clone 会在 checkout 时逐个取回运行时大文件。
// 将运行资产合并为一个 gzip tar，保留原有入口路径，由启动器按版本解压并校验。
const runtimeNames = ["cli.mjs", "hooks.mjs", "symbol-index.mjs", "behavior-reporter.mjs"];
const runtimeBuffers = await Promise.all(runtimeNames.map(async name => ({
  name,
  data: await readFile(join(runtimeBuild, name)),
})));

function tarHeader(name, size) {
  const header = Buffer.alloc(512, 0);
  header.write(name, 0, 100, "utf8");
  header.write("0000644\0", 100, 8, "ascii");
  header.write("0000000\0", 108, 8, "ascii");
  header.write("0000000\0", 116, 8, "ascii");
  header.write(size.toString(8).padStart(11, "0") + "\0", 124, 12, "ascii");
  header.write("00000000000\0", 136, 12, "ascii");
  header[156] = 48;
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  header.write("project-dev-agent", 265, 32, "utf8");
  header.write("project-dev-agent", 297, 32, "utf8");
  header.fill(32, 148, 156);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  return header;
}

function createTar(files) {
  const chunks = [];
  for (const { name, data } of files) {
    chunks.push(tarHeader(name, data.length), data);
    const padding = (512 - (data.length % 512)) % 512;
    if (padding) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

const runtimeArchive = gzipSync(createTar(runtimeBuffers), { level: 9 });
const runtimeHash = createHash("sha256").update(runtimeArchive).digest("hex");
await mkdir(join(target, "runtime"), { recursive: true });
await writeFile(join(target, "runtime/runtime-bundle.tgz"), runtimeArchive);
await rm(runtimeBuild, { recursive: true, force: true });

const loaderTemplate = await readFile(join(root, "scripts/plugin-runtime-loader.mjs"), "utf8");
const loaderSource = loaderTemplate
  .replace("__VERSION__", JSON.stringify(pkg.version))
  .replace("__ARCHIVE_SHA256__", JSON.stringify(runtimeHash))
  .replace("__RUNTIME_FILES__", JSON.stringify(runtimeNames));
await writeFile(join(target, "runtime/loader.mjs"), loaderSource);
await writeFile(join(target, "runtime/cli.mjs"), `// 保持 Codex MCP 的原始入口，实际运行时从用户缓存加载。\nimport { ensureRuntime, runtimeImport } from "./loader.mjs";\nconst { pluginRoot, runtimeRoot } = await ensureRuntime(import.meta.url);\nprocess.env.PROJECT_DEV_PLUGIN_ROOT = pluginRoot;\nawait import(runtimeImport(runtimeRoot, "cli.mjs"));\n`);
await writeFile(join(target, "runtime/hooks.mjs"), `// 保持 Codex Hook 的原始入口，实际运行时从用户缓存加载。\nimport { ensureRuntime, runtimeImport } from "./loader.mjs";\nconst { pluginRoot, runtimeRoot } = await ensureRuntime(import.meta.url);\nprocess.env.PROJECT_DEV_PLUGIN_ROOT = pluginRoot;\nawait import(runtimeImport(runtimeRoot, "hooks.mjs"));\n`);
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
await writeFile(join(target, "README.md"), `# Project Dev Agent ${pkg.version}\n\n此目录是 Codex 插件发布产物，由 \`npm run build:plugin\` 生成，请修改源码后重新构建。\n\n运行环境：Node.js ${runtimeNodeMinimum}+ 和 Git。依赖已打包，无需 npm install。使用 Node 18.19+ 的业务项目可以直接使用，无需升级项目 Node。运行时采用压缩资产和轻量启动器，首次启动按版本与校验值解压到 Codex 用户缓存，后续复用缓存。\n\n安装、更新和迁移说明：[仓库 README](https://github.com/Clearlovesixteen/project-dev-agent#readme)。\n\n新安装默认 auto，信任 SessionStart、UserPromptSubmit、PreToolUse、PostToolUse、Stop 五类钩子后可直接提交开发需求；首次或切换项目时逐个登记当前 Git 仓库，新版显式 workspace 限制保持。旧配置迁移为逐项目模式，不授权父目录。现存 Git merge 冲突使用受限恢复任务，解决后仍验收，不自动提交。确认只读的正则搜索、nl 行号读取、Windows 文件读取和静态读取管道不受其他会话任务阻挡；动态脚本与实际写入仍受控。支持的修改前会核对本轮任务、上下文、实现依据和目标范围；可静态识别的 sed、cp、mv、rm 等 shell 写入还会逐文件核对，未知写入直接拒绝，工具明确失败会保留待确认状态。缺失时由 Agent 补齐后重试。业务模型快照会同时核对源码、依赖和项目配置指纹，配置变化后不会继续使用旧结论。仍可明确使用 \`project-dev\`；调整设置用 \`project-dev-setup\`。旧 manual 在新版首次运行时自动迁移为 auto，无需手动开启；迁移只执行一次，后续主动切回 manual 的设置保留，诊断开关不变，旧范围按逐项目策略迁移；安装不等于钩子已信任或本轮已参与。新安装首次运行默认向维护者发送不含代码、需求或对话正文的运行诊断，可通过项目设置关闭；已有关闭和自定义配置保持原样。\n个人设置在 Codex 用户目录的 \`project-dev-agent/settings.json\`，任务和验证在各工作树的 \`.project-dev/local/\`。同一 Git 仓库的业务模型快照放在 Git 公共目录下的 \`project-dev-agent/\`，每次查询按当前源码选择适用版本。\n`);

const dependencyRoots = new Set();
for (const input of new Set([...Object.keys(result.metafile.inputs), ...Object.keys(hookResult.metafile.inputs), ...Object.keys(symbolResult.metafile.inputs)])) {
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
await writeFile(join(target, "build-info.json"), JSON.stringify({ version: pkg.version, node: runtimeEngines.node,
  business_model_mode: modelReader ? "reader" : "writer", dependencies, files }, null, 2) + "\n");
console.log(JSON.stringify({ version: pkg.version, directory: relative(root, target), files: files.length + 1,
  bytes: files.reduce((sum, file) => sum + file.bytes, 0), bundled_dependencies: dependencies.length }));
