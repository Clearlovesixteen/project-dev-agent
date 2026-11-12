import assert from "node:assert/strict";
import test from "node:test";
import { writeKind } from "../src/hooks/tool-policy.js";

const kind = (command: string, windows = false) => writeKind({ hook_event_name: "PreToolUse", session_id: "readonly-test",
  cwd: windows ? "C:\\work\\sample" : "/work/sample", tool_name: "Bash", tool_input: { command, shell: windows ? "pwsh.exe" : "bash" } });

test("只读搜索的引号内正则与字符不是 shell 控制操作", async t => {
  for (const command of [
    'rg -n "loadDetails|invoke" src', "rg -n 'loadDetails|invoke' src",
    'rg -n "^value$" src', "rg -n 'a;b>c' src", 'rg -- "--pre=pattern" src',
    'rg -n "load\\(value\\)" src', 'grep -nE "load|invoke" src/index.js',
    'rg -n "a&b<c>d" src', "rg -n '\\$literal|other' src", 'rg load src # > not-a-file',
  ]) await t.test(command, () => assert.equal(kind(command), undefined));
});

test("Windows 原生读取、exe 名称和调用运算符可确定为只读", async t => {
  for (const command of [
    'rg.exe -n "loadDetails|invoke" src', 'Get-Content -LiteralPath "src\\main.js"',
    'Get-ChildItem -Path src -Recurse', 'Select-String -Path "src\\main.js" -Pattern "load|invoke"',
    'Get-Content src/main.js | Select-Object -First 20',
    '& "C:\\Program Files\\ripgrep\\rg.exe" -n "load|invoke" src',
    'Get-Content -LiteralPath \'src\\it\'\'s.js\'',
    'powershell.exe -NoProfile -Command "Get-Content src/main.js | Select-Object -First 3"',
    'pwsh -NonInteractive -Command \'Select-String -Path src/main.js -Pattern "load|invoke"\'',
    'pwsh -NoProfile -Command Get-Location',
  ]) await t.test(command, () => assert.equal(kind(command, true), undefined));
});

test("只读命令链、宿主 shell 包装和 Git 工作目录参数不会进入修改检查", async t => {
  for (const command of [
    'pwd; rg -n "load|invoke" src', 'rg -n "load|invoke" src | head -n 20',
    'cd src && cat index.js', 'git -C /work/sample status --short',
    'git --no-pager diff -- src/index.js', 'git branch --list "feature/*"',
    '/bin/zsh -lc \'rg -n "load|invoke" src\'',
    '/bin/zsh -lc pwd',
    'bash -c "cat src/index.js | head -n 5"',
    'sed -n \'1,20p\' src/index.js | head -n 3',
    'nl -ba src/index.js', 'cat src/index.js | sed -n \'1,20p\'',
    'nl -ba src/index.js | sed -n \'1,20p\'', 'git status --short && nl -ba src/index.js',
    'bash -lc \'nl -ba src/index.js | head -n 20\'',
  ]) await t.test(command, () => assert.equal(kind(command), undefined));
});

test("管道中含写入、重定向和执行扩展时仍进入修改检查", async t => {
  for (const command of [
    'rg "load|invoke" src > result.txt', 'rg load src | tee result.txt',
    'cat src/index.js; rm src/index.js', 'cat src/index.js && node -e "write()"',
    'rg --pre=node load src', 'rg --pre node load src',
    'rg --hostname-bin=/tmp/script load src', 'sed -i "s/a/b/" src/index.js',
    'git diff --output=result.txt', 'git branch -D other',
    'file -C -m custom.magic',
    'sh -c \'cat src/index.js; touch result.txt\'',
    'nl -ba src/index.js > result.txt', 'nl -ba src/index.js | tee result.txt',
    'nl -ba src/index.js; touch result.txt', 'nl -ba "$(touch result.txt)"',
    'cat src/index.js | sed -n \'1,20w result.txt\'',
    'cat src/index.js | sed -n \'1,20p; e touch result.txt\'',
    'cat src/index.js | sed -n \'1,20p\' --file script.sed',
  ]) await t.test(command, () => assert.equal(kind(command), "shell"));
  for (const command of [
    'Get-Content src/main.js | Set-Content other.js', 'Get-Content src/main.js > other.js',
    'powershell.exe -NoProfile -Command "Get-Content src/main.js; Remove-Item src/main.js"',
    'pwsh -EncodedCommand ZQBjAGgAbwAgAHgA',
  ]) await t.test(command, () => assert.equal(kind(command, true), "shell"));
});

test("动态替换、脚本块、未闭合引号和超限输入不直接放行", async t => {
  for (const command of [
    'cat "$(node -e evil)"', 'cat `node -e evil`', 'rg "$PATTERN" src',
    'rg "unclosed src', 'python -c "print(1)"', 'node -e "console.log(1)"',
    'cat x | xargs rm', 'cat '+ 'x'.repeat(70000),
  ]) await t.test(command.slice(0, 90), () => assert.equal(kind(command), "shell"));
  for (const command of [
    'Get-Content "$(Remove-Item x)"', 'Get-Content $path',
    'Get-Content @parameters',
    'Get-Content x | ForEach-Object { Set-Content other $_ }',
  ]) await t.test(command, () => assert.equal(kind(command, true), "shell"));
});

test("插件管理仍可执行且不把配置字面值误认为管道", () => {
  assert.equal(kind('codex -c \'marketplaces.project-dev-team.sparse_paths=[".agents/plugins","plugins/project-dev-agent"]\' plugin list --marketplace project-dev-team --json'), undefined);
  assert.equal(kind('git switch --detach published'), undefined);
  const root = 'C:\\Users\\Person\\.codex\\plugins\\agent\\0.13.5';
  assert.equal(writeKind({ hook_event_name: "PreToolUse", cwd: 'C:\\work', session_id: "windows-cli", tool_name: "Bash",
    tool_input: { command: 'node.exe "c:\\users\\person\\.CODEX\\plugins\\AGENT\\0.13.5\\runtime\\cli.mjs" runtime status' } }, root), undefined);
});
