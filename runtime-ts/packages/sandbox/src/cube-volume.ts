import type { TenantId } from "@aisay/domain";
import { SandboxRuntimeError } from "./errors.js";

const VOLUME_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;

export interface CubeVolumeMount {
  readonly name: string;
  readonly path: "/resources";
}

export interface TenantResourceVolumePort {
  ensure(input: {
    readonly tenantId: TenantId;
    readonly signal?: AbortSignal;
  }): Promise<CubeVolumeMount>;
  probe(): Promise<void>;
}

export interface CubeTenantResourceVolumeOptions {
  readonly apiUrl: string;
  readonly apiKey?: string | null;
  readonly driver: string;
  readonly requestTimeoutMs?: number;
}

type FetchPort = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Pick<Response, "ok" | "status" | "json" | "body">>;

/**
 * 每个 Tenant 固定复用一个 Cube Volume；卷本身不保存业务数据，只选择宿主机只读 ResourceFS 视图。
 * 因而它可跨 Thread/Sandbox 长期存在，真实持久化仍完全属于 PostgreSQL Resource 与 MinIO Blob。
 */
export class CubeTenantResourceVolume implements TenantResourceVolumePort {
  private readonly apiUrl: string;
  private readonly driver: string;
  private readonly requestTimeoutMs: number;
  private readonly pending = new Map<string, Promise<CubeVolumeMount>>();

  constructor(
    options: CubeTenantResourceVolumeOptions,
    private readonly fetcher: FetchPort = fetch,
  ) {
    const apiUrl = new URL(options.apiUrl);
    if (
      (apiUrl.protocol !== "http:" && apiUrl.protocol !== "https:") ||
      apiUrl.username !== "" ||
      apiUrl.password !== "" ||
      apiUrl.search !== "" ||
      apiUrl.hash !== ""
    ) {
      throw new SandboxRuntimeError("INVALID_ARGUMENT", "Cube Volume API URL 无效");
    }
    if (!VOLUME_NAME_PATTERN.test(options.driver)) {
      throw new SandboxRuntimeError("INVALID_ARGUMENT", "Cube Resource Volume driver 无效");
    }
    const requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1) {
      throw new SandboxRuntimeError("INVALID_ARGUMENT", "Cube Volume 请求超时无效");
    }
    this.apiUrl = apiUrl.toString().replace(/\/$/u, "");
    this.driver = options.driver;
    this.requestTimeoutMs = requestTimeoutMs;
    this.apiKey = options.apiKey?.trim() || undefined;
  }

  private readonly apiKey: string | undefined;

  async ensure(input: {
    readonly tenantId: TenantId;
    readonly signal?: AbortSignal;
  }): Promise<CubeVolumeMount> {
    const name = volumeName(input.tenantId);
    const existing = this.pending.get(name);
    if (existing !== undefined) return existing;
    const operation = this.ensureRemote(name, input.signal).finally(() =>
      this.pending.delete(name),
    );
    this.pending.set(name, operation);
    return operation;
  }

  async probe(): Promise<void> {
    const response = await this.request("/volumes", { method: "GET" });
    if (!response.ok) {
      await discard(response);
      throw responseError(response.status, "探测 Cube Volume API");
    }
    const payload = await parseJson(response, "探测 Cube Volume API");
    if (!Array.isArray(payload) && !isRecord(payload)) {
      throw new SandboxRuntimeError("PROTOCOL", "Cube Volume 列表响应无效");
    }
  }

  private async ensureRemote(name: string, signal?: AbortSignal): Promise<CubeVolumeMount> {
    const current = await this.request(`/volumes/${name}`, {
      method: "GET",
      ...(signal === undefined ? {} : { signal }),
    });
    if (current.ok) {
      assertVolume(await parseJson(current, "读取 Cube Resource Volume"), name);
      return Object.freeze({ name, path: "/resources" });
    }
    if (current.status !== 404) {
      await discard(current);
      throw responseError(current.status, "读取 Cube Resource Volume");
    }
    await discard(current);

    const created = await this.request("/volumes", {
      method: "POST",
      ...(signal === undefined ? {} : { signal }),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, driver: this.driver }),
    });
    if (created.ok) {
      assertVolume(await parseJson(created, "创建 Cube Resource Volume"), name);
      return Object.freeze({ name, path: "/resources" });
    }
    // 多 Worker 首次同时创建同一 Tenant 卷时，冲突只允许通过单查确认同名卷来收敛。
    if (created.status === 409) {
      await discard(created);
      const raced = await this.request(`/volumes/${name}`, {
        method: "GET",
        ...(signal === undefined ? {} : { signal }),
      });
      if (raced.ok) {
        assertVolume(await parseJson(raced, "确认并发创建的 Cube Resource Volume"), name);
        return Object.freeze({ name, path: "/resources" });
      }
      await discard(raced);
    } else {
      await discard(created);
    }
    throw responseError(created.status, "创建 Cube Resource Volume");
  }

  private async request(path: string, init: RequestInit): ReturnType<FetchPort> {
    const timeout = AbortSignal.timeout(this.requestTimeoutMs);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    const headers = new Headers(init.headers);
    if (this.apiKey !== undefined) {
      headers.set("authorization", `Bearer ${this.apiKey}`);
      // Cube 0.6 Python Volume SDK 使用 X-API-Key；同时发送以兼容现有 Node 管控面鉴权。
      headers.set("x-api-key", this.apiKey);
    }
    try {
      return await this.fetcher(`${this.apiUrl}${path}`, { ...init, headers, signal });
    } catch (error) {
      if (init.signal?.aborted) {
        throw new SandboxRuntimeError("CANCELLED", "Cube Volume 请求已取消", error);
      }
      if (timeout.aborted) throw new SandboxRuntimeError("TIMEOUT", "Cube Volume 请求超时", error);
      throw new SandboxRuntimeError("UPSTREAM", "Cube Volume 请求失败", error);
    }
  }
}

function volumeName(tenantId: TenantId): string {
  // Cube Volume 名称最多 128 字符；Tenant ID 已使用相同字符集，因此可作为稳定、可逆的插件租户选择器。
  if (!VOLUME_NAME_PATTERN.test(tenantId)) {
    throw new SandboxRuntimeError("INVALID_ARGUMENT", "Tenant ID 不能投影为 Cube Resource Volume");
  }
  return tenantId;
}

async function parseJson(response: Pick<Response, "json">, operation: string): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    throw new SandboxRuntimeError("PROTOCOL", `${operation} 的响应不是 JSON`, error);
  }
}

function assertVolume(payload: unknown, expectedName: string): void {
  if (!isRecord(payload)) throw new SandboxRuntimeError("PROTOCOL", "Cube Volume 响应无效");
  const volumeId = payload.volumeID ?? payload.volume_id;
  if (volumeId !== expectedName || payload.name !== expectedName) {
    throw new SandboxRuntimeError("PROTOCOL", "Cube Resource Volume 身份不一致");
  }
}

function responseError(status: number, operation: string): SandboxRuntimeError {
  const code = status === 401 || status === 403 ? "AUTHENTICATION" : "UPSTREAM";
  return new SandboxRuntimeError(code, `${operation}失败（HTTP ${status}）`);
}

async function discard(response: Pick<Response, "body">): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
