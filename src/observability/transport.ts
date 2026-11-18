import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Agent, fetch, ProxyAgent, type Dispatcher, type Response } from "undici";
import { z } from "zod";
import { BatchAcknowledgementV2 } from "./batch.js";

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

export class DiagnosticHttpError extends Error {
  constructor(readonly status: number) { super(`UPLOAD_HTTP_${status}`); }
}

type UploadStage = "connect" | "response" | "ack";
const timeoutReasons = { connect: "UPLOAD_TIMEOUT_CONNECT", response: "UPLOAD_TIMEOUT_RESPONSE", ack: "UPLOAD_TIMEOUT_ACK" } as const;

export class DiagnosticTimeoutError extends Error {
  readonly code;
  constructor(readonly stage: UploadStage) {
    super(timeoutReasons[stage]);
    this.code = timeoutReasons[stage];
  }
}

async function acknowledgement(response: Response, profile: 1 | 2) {
  if (!response.ok) {
    await response.body?.getReader().cancel().catch(() => {});
    throw new DiagnosticHttpError(response.status);
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
    const raw: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return profile === 2 ? BatchAcknowledgementV2.parse(raw)
      : z.object({ batch_id: z.string(), acknowledged: z.number().int().nonnegative() }).strict().parse(raw);
  } finally { await reader.cancel().catch(() => {}); }
}

type DiagnosticRequest = { endpoint: string; token: string; body: string; signal: AbortSignal; profile?: 1 | 2 };

/** 在同一次收尾内复用同源连接。代理选择、请求和回执读取共享已有发送预算。 */
export class DiagnosticTransport {
  private agent?: Dispatcher;
  private readonly origin: string;

  constructor(endpoint: string, private readonly options: ProxyOptions = {}) {
    this.origin = new URL(endpoint).origin;
  }

  async send(input: DiagnosticRequest) {
    if (new URL(input.endpoint).origin !== this.origin) throw new Error("UPLOAD_ORIGIN_CHANGED");
    let stage: UploadStage = "connect";
    try {
      input.signal.throwIfAborted();
      if (!this.agent) {
        const proxy = await diagnosticProxy(input.endpoint, input.signal, this.options);
        this.agent = proxy ? new ProxyAgent({ uri: proxy, connections: 1 }) : new Agent({ connections: 1 });
      }
      // onConnect 发生在连接可用且请求即将交给 socket 时，涵盖代理选择、隧道与 TLS 建连这段预算。
      const dispatcher = this.agent.compose(dispatch => (options, handler) => dispatch(options, {
        ...handler,
        onConnect(abort) {
          stage = "response";
          handler.onConnect?.call(this, abort);
        },
      }));
      const response = await fetch(input.endpoint, { method: "POST", redirect: "error", signal: input.signal,
        dispatcher, headers: { "Content-Type": "application/json", Authorization: `Bearer ${input.token}` }, body: input.body });
      stage = "ack";
      return await acknowledgement(response, input.profile ?? 1);
    } catch (error) {
      if (input.signal.aborted && !(error instanceof DiagnosticHttpError)) throw new DiagnosticTimeoutError(stage);
      throw error;
    }
  }

  async close() {
    await this.agent?.destroy().catch(() => {});
  }
}

/** 单批调用同样只使用局部连接，不改全局网络配置。 */
export async function sendDiagnosticBatch(input: DiagnosticRequest, options: ProxyOptions = {}) {
  const transport = new DiagnosticTransport(input.endpoint, options);
  try {
    return await transport.send(input);
  } finally { await transport.close(); }
}
