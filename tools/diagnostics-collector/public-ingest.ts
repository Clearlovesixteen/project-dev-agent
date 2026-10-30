interface Limiter { limit(options: { key: string }): Promise<{ success: boolean }>; }
export interface PublicLimits { PUBLIC_SOURCE_LIMIT?: Limiter; PUBLIC_TOTAL_LIMIT?: Limiter; }

/** 只在限流器中使用短暂散列，不将来源 IP 写入事件或数据库。限额按 Cloudflare 位置近似生效。 */
export async function publicRequestAllowed(request: Request, limits: PublicLimits) {
  if (!limits.PUBLIC_SOURCE_LIMIT || !limits.PUBLIC_TOTAL_LIMIT) throw new Error("PUBLIC_LIMITS_MISSING");
  const bytes = new TextEncoder().encode(request.headers.get("CF-Connecting-IP") ?? "unknown");
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), value => value.toString(16).padStart(2, "0")).join("");
  if (!(await limits.PUBLIC_TOTAL_LIMIT.limit({ key: "public-diagnostics" })).success) return false;
  return (await limits.PUBLIC_SOURCE_LIMIT.limit({ key: `source:${digest}` })).success;
}

export async function publicInstallAllowed(installId: string, limits: PublicLimits) {
  if (!limits.PUBLIC_SOURCE_LIMIT) throw new Error("PUBLIC_LIMITS_MISSING");
  return (await limits.PUBLIC_SOURCE_LIMIT.limit({ key: `install:${installId}` })).success;
}
