/** 旧版同进程结果没有查询类型；仍须包含可用实现依据才能就绪。 */
export function isImplementationQuery(data: Record<string, unknown>): boolean {
  return data.context_query_kind === "implementation" || data.context_query_kind === undefined;
}

/** 结构索引已过期或目标全部排除时，当前查询不能证明准备已完成。 */
export function implementationContextReady(data: Record<string, unknown>): boolean {
  const implementation = data.implementation_context;
  return isImplementationQuery(data) && ["indexed", "partial", "needs_review"].includes(String(data.state))
    && !!implementation && typeof implementation === "object" && !Array.isArray(implementation);
}
