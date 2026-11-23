import assert from "node:assert/strict";
import test from "node:test";
import { outsideBindings, selectSymbol } from "../src/understanding/symbol-index.js";

test("Vue 脚本声明按原文件区间定位，模板与相邻声明仍受保护", () => {
  const source = '<template><p>🪴你好</p></template>\n<script setup lang="ts">\nconst allowed = () => 1;\nconst neighbor = () => 2;\n</script>';
  const binding = selectSymbol("Panel.vue", source, "allowed");
  assert.equal(binding.resolution, "resolved");
  assert.equal(source.slice(binding.start, binding.end), "const allowed = () => 1;");
  const before = outsideBindings("Panel.vue", source, ["allowed"]);
  assert.ok(before);
  assert.equal(outsideBindings("Panel.vue", source.replace("=> 1", "=> 123"), ["allowed"]), before);
  assert.notEqual(outsideBindings("Panel.vue", source.replace("=> 2", "=> 3"), ["allowed"]), before);
  assert.notEqual(outsideBindings("Panel.vue", source.replace("你好", "再见"), ["allowed"]), before);
});

test("双脚本的同名符号保留歧义，外部脚本或模板内的文字不能作为本地定义", () => {
  const code = '<script>const value=1</script><script setup>const value=2</script>';
  assert.equal(selectSymbol("Card.vue", code, "value").resolution, "ambiguous");
  assert.equal(outsideBindings("Card.vue", code, ["value"]), undefined);
  for (const source of ['<script src="./external.ts"></script>', "<template><!-- <script>const value=1</script> --></template>",
    "<script>const value=1</script><script>const other=2</script>"])
    assert.equal(selectSymbol("Card.vue", source, "value").resolution, "unsupported");
  const blocks = '<script>export const id=1</script>\n<script setup lang="ts">const selected=id</script>';
  assert.equal(selectSymbol("Card.vue", blocks, "selected").resolution, "resolved");
  assert.notEqual(outsideBindings("Card.vue", blocks, ["selected"]),
    outsideBindings("Card.vue", blocks.replace("id=1", "id=2"), ["selected"]));
});
