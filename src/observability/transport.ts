import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fetch as proxyFetch, ProxyAgent, type Response as ProxyResponse } from "undici";
import { z } from "zod";

const execute = promisify(execFile);
type ProxyOptions = { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; readSystem?: (signal: AbortSignal) => Promise<string> };

function excluded(url: URL, value: string) {
  const host = url.hostname.toLowerCase(), port = url.port || (url.protocol === "https:" ? "443" : "80");
  return value.split(/[\s,]+/).some(entry => {
    if (entry === "*") return true;
    const parsed = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(entry.toLowerCase());
    if (!parsed || parsed[2] && parsed[2] !== port) return false;
    const pattern = parsed[1]!;
    if (pattern.startsWith(".") || pattern.startsWith("*.")) {
      const domain = pattern.replace(/^\*?\./, "");
      return host === domain || host.endsWith(`.${domain}`);
    }
    return host === pattern;
  });
}

function proxyUrl(value: string) {
  const url = new URL(value);
  if (value.length > 4096 || !["http:", "https:"].includes(url.protocol) || url.pathname !== "/" || url.search || url.hash)
    throw new Error("UPLOAD_PROXY_INVALID");
  return url.href;
}

/** 只读已有系统代理；查询有独立短超时，不设置全局 dispatcher 或改变系统网络。 */
async function macProxy(signal: AbortSignal) {
  return (await execute("/usr/sbin/scutil", ["--proxy"], { timeout: 250, maxBuffer: 32768, signal })).stdout;
}

/** 环境代理优先，macOS 补读 HTTP/HTTPS 静态系统代理；回环与 NO_PROXY 始终直连。 */
export async function diagnosticProxy(endpoint: string, signal: AbortSignal, options: ProxyOptions = {}): Promise<string | null> {
  signal.throwIfAborted();
  const url = new URL(endpoint), env = options.env ?? process.env;
  if (url.hostname === "localhost" || url.hostname === "[::1]" || /^127\./.test(url.hostname)
    || excluded(url, env.no_proxy ?? env.NO_PROXY ?? "")) return null;
  const configured = url.protocol === "https:"
    ? env.https_proxy ?? env.HTTPS_PROXY ?? env.http_proxy ?? env.HTTP_PROXY ?? env.all_proxy ?? env.ALL_PROXY
    : env.http_proxy ?? env.HTTP_PROXY ?? env.all_proxy ?? env.ALL_PROXY;
  // 显式的空环境变量也应覆盖系统代理，避免用户要求直连时又隐式代理。
  if (configured !== undefined) return configured ? proxyUrl(configured) : null;
  if ((options.platform ?? process.platform) !== "darwin") return null;
  let raw: string;
  try { raw = await (options.readSystem ?? macProxy)(signal); }
  catch { signal.throwIfAborted(); return null; }
  const fields = new Map([...raw.matchAll(/^\s*(HTTPS?(?:Enable|Proxy|Port))\s*:\s*(.*?)\s*$/gm)].map(match => [match[1]!, match[2]!]));
  const kind = url.protocol === "https:" ? "HTTPS" : "HTTP";
  if (fields.get(`${kind}Enable`) !== "1") return null;
  const host = fields.get(`${kind}Proxy`) ?? "", port = fields.get(`${kind}Port`) ?? "";
  if (!/^[a-zA-Z0-9_.:\[\]-]{1,255}$/.test(host) || !/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535)
    throw new Error("UPLOAD_PROXY_INVALID");
  const address = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return proxyUrl(`http://${address}:${port}`);
}

async function acknowledgement(response: Response | ProxyResponse) {
  if (!response.ok) {
    await response.body?.getReader().cancel().catch(() => {});
    throw new Error(`UPLOAD_HTTP_${response.status}`);
  }
  if (!response.body) throw new Error("UPLOAD_RESPONSE_INVALID");
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      if (!part.value) throw new Error("UPLOAD_RESPONSE_INVALID");
      bytes += part.value.length;
      if (bytes > 4096) throw new Error("UPLOAD_RESPONSE_LIMIT");
      chunks.push(part.value);
    }
    return z.object({ batch_id: z.string(), acknowledged: z.number().int().nonnegative() }).strict()
      .parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  } finally { await reader.cancel().catch(() => {}); }
}

/** 每次发送独立的代理连接，不重定向、不降低 TLS 校验、不把代理地址或凭证写进诊断。 */
export async function sendDiagnosticBatch(input: { endpoint: string; token: string; body: string; signal: AbortSignal }, options: ProxyOptions = {}) {
  const proxy = await diagnosticProxy(input.endpoint, input.signal, options), agent = proxy ? new ProxyAgent(proxy) : undefined;
  const request = { method: "POST", redirect: "error" as const, signal: input.signal,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${input.token}` }, body: input.body };
  try {
    const response = agent ? await proxyFetch(input.endpoint, { ...request, dispatcher: agent }) : await fetch(input.endpoint, request);
    return await acknowledgement(response);
  } finally { await agent?.destroy().catch(() => {}); }
}
