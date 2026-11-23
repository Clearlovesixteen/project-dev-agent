import { NodeTypes, parse } from "@vue/compiler-dom";

/** 用 Vue 的 SFC 解析模式读取顶层脚本。offset 和 Babel 一样以原字符串的 UTF-16 位置表示。 */
export function vueScriptBlocks(source: string) {
  const blocks: { path: string; start: number; end: number; setup: boolean }[] = [];
  const root = parse(source, { parseMode: "sfc" });
  for (const node of root.children) {
    if (node.type !== NodeTypes.ELEMENT || node.tag !== "script") continue;
    const attrs = new Map<string, string | undefined>();
    for (const prop of node.props) {
      if (prop.type !== NodeTypes.ATTRIBUTE || attrs.has(prop.name)) return [];
      attrs.set(prop.name, prop.value?.content);
    }
    const lang = attrs.get("lang") ?? "js", setup = attrs.has("setup");
    // 外部脚本及自定义预处理器不能在当前文件内授权。相同类型的两个脚本是无效 SFC。
    if (!node.innerLoc || attrs.has("src") || !["js", "jsx", "ts", "tsx"].includes(lang)
      || blocks.some(block => block.setup === setup)) return [];
    blocks.push({ path: `inline.${lang}`, start: node.innerLoc.start.offset, end: node.innerLoc.end.offset, setup });
  }
  return blocks;
}
