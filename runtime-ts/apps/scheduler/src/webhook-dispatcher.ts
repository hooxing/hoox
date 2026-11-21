import type { ClientRequest, IncomingMessage } from "node:http";
import { request } from "node:https";
import { isIP } from "node:net";
import { checkServerIdentity, type PeerCertificate } from "node:tls";
import { validateExternalHttpsTarget } from "@hoox/tool-router";
import {
  signWebhook,
  type ClaimedWebhookDelivery,
  type EncryptedWebhookSecret,
  type WebhookSendPermit,
  type WebhookSettlement,
} from "@hoox/persistence/postgres";

export type WebhookTarget = Awaited<ReturnType<typeof validateExternalHttpsTarget>>;
type TrustAnchors = string | Buffer | ReadonlyArray<string | Buffer>;

/** Dispatcher 依赖的 Outbox 端口；生产实现为 `PgWebhookOutboxStore`。 */
export interface WebhookOutboxPort {
  readonly leaseMs: number;
  readonly maxAttempts: number;
  claim(input: {
    readonly owner: string;
    readonly excludedTenantIds?: readonly string[];
  }): Promise<ClaimedWebhookDelivery | undefined>;
  permitSend(delivery: ClaimedWebhookDelivery, sendBudgetMs: number): Promise<WebhookSendPermit>;
  settle(delivery: ClaimedWebhookDelivery, settlement: WebhookSettlement): Promise<void>;
}

export interface WebhookDispatcherOptions {
  readonly store: WebhookOutboxPort;
  readonly cipher: {
    decrypt(tenantId: string, webhookId: string, value: EncryptedWebhookSecret): string;
  };
  readonly owner: string;
  /** 同一进程内的最大并发投递数；同一 Tenant 同时最多占用一个槽位。 */
  readonly concurrency?: number;
  /** DNS、连接、TLS 与响应共用的单次绝对时限，必须明显短于领取租约。 */
  readonly deadlineMs?: number;
  /** 仅测试注入：替换公网目标校验与解析。 */
  readonly resolveTarget?: (url: string) => Promise<WebhookTarget>;
  /** 仅私有 CA 部署与测试使用。 */
  readonly ca?: TrustAnchors;
}

const responseLimit = 64 * 1024;
const defaultDeadlineMs = 10_000;
// 发送时限之外为复核与结算预留的租约余量，保证租约到期前本次尝试已经结束。
const settleMarginMs = 5_000;

class WebhookDeliveryError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/**
 * Tenant Webhook 投递循环。每次投递：领取（计入次数）→ 在截止时间内校验目标 →
 * 发送前复核订阅仍启用并读取当前密钥 → 签名 → 直拨已校验 IP 发送 → 以领取令牌结算一次。
 */
export class WebhookDispatcher {
  readonly #store: WebhookOutboxPort;
  readonly #options: WebhookDispatcherOptions;
  readonly #concurrency: number;
  readonly #deadlineMs: number;
  readonly #inFlight = new Map<Promise<void>, string>();
  #pumping: Promise<void> | undefined;
  #closed = false;

  constructor(options: WebhookDispatcherOptions) {
    this.#store = options.store;
    this.#options = options;
    this.#concurrency = options.concurrency ?? 4;
    this.#deadlineMs = options.deadlineMs ?? defaultDeadlineMs;
    if (!Number.isInteger(this.#concurrency) || this.#concurrency < 1)
      throw new TypeError("WEBHOOK_DISPATCH_CONCURRENCY_INVALID");
    if (
      !Number.isInteger(this.#deadlineMs) ||
      this.#deadlineMs < 100 ||
      this.#deadlineMs + settleMarginMs > options.store.leaseMs
    )
      throw new TypeError("WEBHOOK_DISPATCH_DEADLINE_INVALID");
  }

  get inFlight(): number {
    return this.#inFlight.size;
  }

  /**
   * 填满空闲槽位后返回；投递在后台继续。领取失败（数据库不可用）只结束本轮，下一轮重试。
   * 单个慢接收端最多占用一个槽位直到截止时间，不会阻塞其他 Tenant。
   */
  pump(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    this.#pumping ??= this.#fill().finally(() => {
      this.#pumping = undefined;
    });
    return this.#pumping;
  }

  /** 停止领取并等待所有在途投递结算；每条投递都受截止时间约束，因此等待有界。 */
  async close(): Promise<void> {
    this.#closed = true;
    await this.#pumping;
    await Promise.all([...this.#inFlight.keys()]);
  }

  async #fill(): Promise<void> {
    try {
      while (!this.#closed && this.#inFlight.size < this.#concurrency) {
        const delivery = await this.#store.claim({
          owner: this.#options.owner,
          excludedTenantIds: [...new Set(this.#inFlight.values())],
        });
        if (delivery === undefined) return;
        const task: Promise<void> = this.deliver(delivery)
          .catch(() => undefined)
          .finally(() => {
            this.#inFlight.delete(task);
          });
        this.#inFlight.set(task, delivery.tenantId);
      }
    } catch {
      // 领取失败不输出数据库细节；下一轮定时 pump 重试。
    }
  }

  /** 处理一条已领取的投递并只结算一次；不抛出对端或数据库细节。 */
  async deliver(delivery: ClaimedWebhookDelivery): Promise<void> {
    const deadlineAt = Date.now() + this.#deadlineMs;
    let settlement: WebhookSettlement;
    try {
      const target = await withDeadline(
        (this.#options.resolveTarget ?? validateExternalHttpsTarget)(delivery.endpointUrl),
        deadlineAt,
      );
      if (isIP(target.address) === 0) throw new WebhookDeliveryError("target_rejected");
      const permit = await this.#store.permitSend(
        delivery,
        Math.max(0, deadlineAt - Date.now()) + settleMarginMs,
      );
      // 订阅已停用（复核时已结算）或领取已被租约恢复替换：本次不发送。
      if (permit.outcome === "skip") return;
      let secret: string;
      try {
        secret = this.#options.cipher.decrypt(
          delivery.tenantId,
          delivery.webhookId,
          permit.secretCiphertext,
        );
      } catch {
        throw new WebhookDeliveryError("secret_unavailable");
      }
      const body = Buffer.from(JSON.stringify(delivery.payload));
      const timestamp = String(Date.now());
      await sendWebhookRequest({
        target,
        body,
        headers: {
          "content-type": "application/json",
          "content-length": String(body.byteLength),
          "x-hoox-event-id": delivery.eventId,
          "x-hoox-timestamp": timestamp,
          "x-hoox-signature": signWebhook(secret, timestamp, delivery.eventId, body),
        },
        deadlineAt,
        ...(this.#options.ca === undefined ? {} : { ca: this.#options.ca }),
      });
      settlement = { kind: "delivered" };
    } catch (error) {
      const code = error instanceof WebhookDeliveryError ? error.code : "delivery_failed";
      settlement =
        delivery.attempts >= this.#store.maxAttempts
          ? { kind: "exhausted", errorCode: code }
          : {
              kind: "retry",
              errorCode: code,
              delayMs: Math.min(3_600_000, 2_000 * 2 ** Math.min(delivery.attempts - 1, 10)),
            };
    }
    await this.#store.settle(delivery, settlement).catch(() => undefined);
  }
}

// 目标校验（含 DNS）受同一截止时间约束；超时后不再等待底层解析，也不发送请求。
function withDeadline<T>(operation: Promise<T>, deadlineAt: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new WebhookDeliveryError("timeout")),
      Math.max(0, deadlineAt - Date.now()),
    );
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        reject(new WebhookDeliveryError("target_rejected"));
      },
    );
  });
}

/**
 * 发送单次 Webhook 请求。每次新建连接（`agent: false`，不复用连接池、不继承代理）并直拨已校验 IP；
 * SNI 与证书校验使用原主机名，`Host` 保留原 URL 主机部分；不跟随重定向。
 * 连接、TLS、请求与完整响应共用 `deadlineAt`；超时、请求或响应错误、不完整关闭与响应超限
 * 都会销毁连接并只结算一次。仅 2xx 且完整读完（不超过 64 KiB）的响应视为送达。
 */
export function sendWebhookRequest(input: {
  readonly target: WebhookTarget;
  readonly body: Buffer;
  readonly headers: Readonly<Record<string, string>>;
  readonly deadlineAt: number;
  readonly ca?: TrustAnchors;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    // 数据库复核或本地签名也可能耗尽预算；过期后不能再创建套接字。
    if (input.deadlineAt <= Date.now()) {
      reject(new WebhookDeliveryError("timeout"));
      return;
    }
    let settled = false;
    let req: ClientRequest | undefined;
    let res: IncomingMessage | undefined;
    const timer = setTimeout(
      () => settle(new WebhookDeliveryError("timeout")),
      Math.max(0, input.deadlineAt - Date.now()),
    );
    function settle(error?: WebhookDeliveryError) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // 无论成功失败都销毁连接：agent:false 下连接不复用，也避免慢速正文越过时限。
      res?.destroy();
      req?.destroy();
      if (error === undefined) resolve();
      else reject(error);
    }
    const hostname = input.target.hostname;
    try {
      req = request(
        {
          protocol: "https:",
          host: input.target.address,
          port: Number(input.target.url.port || 443),
          ...(isIP(input.target.servername) ? {} : { servername: input.target.servername }),
          checkServerIdentity: (_host: string, cert: PeerCertificate) =>
            checkServerIdentity(hostname, cert),
          agent: false,
          rejectUnauthorized: true,
          method: "POST",
          path: `${input.target.url.pathname}${input.target.url.search}`,
          headers: { ...input.headers, host: input.target.hostHeader },
          ...(input.ca === undefined
            ? {}
            : { ca: input.ca as string | Buffer | Array<string | Buffer> }),
        },
        (response) => onResponse(response),
      );
    } catch {
      settle(new WebhookDeliveryError("target_rejected"));
      return;
    }
    req.on("error", () => settle(new WebhookDeliveryError("connection_failed")));
    req.on("close", () => {
      if (res === undefined) settle(new WebhookDeliveryError("connection_failed"));
    });
    req.end(input.body);

    function onResponse(response: IncomingMessage) {
      res = response;
      const status = response.statusCode ?? 0;
      response.on("error", () => settle(new WebhookDeliveryError("response_failed")));
      response.on("close", () => {
        if (!response.complete) settle(new WebhookDeliveryError("response_failed"));
      });
      if (Number(response.headers["content-length"]) > responseLimit) {
        settle(new WebhookDeliveryError("response_too_large"));
        return;
      }
      let length = 0;
      response.on("data", (chunk: Buffer) => {
        length += chunk.byteLength;
        if (length > responseLimit) settle(new WebhookDeliveryError("response_too_large"));
      });
      response.on("end", () => {
        if (!response.complete) settle(new WebhookDeliveryError("response_failed"));
        else if (status >= 200 && status < 300) settle();
        else settle(new WebhookDeliveryError("non_success_response"));
      });
    }
  });
}
