/** 单独加载静态解析器。普通对话的钩子启动和旧模型查询无需初始化 Babel。 */
export async function loadSymbolIndex(): Promise<typeof import("./symbol-index.js")> {
  const path = import.meta.url.endsWith(".mjs") ? "./symbol-index.mjs" : "./symbol-index.js";
  return import(path);
}
