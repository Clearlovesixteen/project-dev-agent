import { AppError } from "../domain/error.js";

/** 数组下标指向原请求，ID 指向已解析条目。只描述待核对字段，不把原文回填给模型。 */
export type ReferenceIssue = { index: number; id: string; fields: string[]; reason: string };

export function referenceError(issues: ReferenceIssue[], verified: string[], code = "IMPLEMENTATION_REFERENCE_INVALID") {
  return new AppError(code,
    `请核对实现依据的路径、哈希及行文。需补查的引用：${issues.map(item => item.id).join("、")}。`,
    { reference_issues: issues, verified_reference_ids: verified });
}
