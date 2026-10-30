/**
 * 发布者公开的诊断策略。ingest_key 是可随插件公开分发的接收标识，绝非管理员或私有写入密钥。
 * 接收端仅允许此标识提交白名单元数据，并独立限流；它不能读取诊断或访问 Cloudflare 账户。
 */
export const PUBLISHED_DIAGNOSTICS = Object.freeze({
  endpoint: "https://project-dev-diagnostics.clearlovesixteen-project-dev.workers.dev/public/events",
  ingest_key: "pda_public_v1_7d5fd085a76a4a3ea3a29b586bec540e",
  notice_version: "2026-10-29-v1" as const,
  policy: "public-default-2026-10-30",
});
