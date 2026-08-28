export interface RunDisplayMetadata {
  readonly runId: string;
  readonly threadId: string;
  readonly title: string;
  readonly createdAt?: string;
}

export interface RunMetadataProvider {
  resolve(runIds: readonly string[]): Promise<ReadonlyMap<string, RunDisplayMetadata>>;
}

interface RuntimeApiMetadataOptions {
  readonly origin: string;
  readonly fetcher?: typeof fetch;
  readonly cacheTtlMs?: number;
  readonly now?: () => number;
}

interface Actor {
  readonly authorization: "Bearer dev-user-a" | "Bearer dev-user-b";
}

const actors: readonly Actor[] = [
  { authorization: "Bearer dev-user-a" },
  { authorization: "Bearer dev-user-b" },
];
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/u;

/**
 * 维护者查看器只通过现有 development API 读取已授权的 Thread/Run 元数据；失败时退回 runId，
 * 不直接使用跨租户数据库角色，也不把开发身份暴露给浏览器。
 */
export class DevelopmentRuntimeApiMetadataProvider implements RunMetadataProvider {
  readonly #origin: string;
  readonly #fetcher: typeof fetch;
  readonly #cacheTtlMs: number;
  readonly #now: () => number;
  #cache = new Map<string, RunDisplayMetadata>();
  #expiresAt = 0;
  #refreshing: Promise<void> | undefined;

  constructor(options: RuntimeApiMetadataOptions) {
    this.#origin = normalizeLoopbackOrigin(options.origin);
    this.#fetcher = options.fetcher ?? fetch;
    this.#cacheTtlMs = options.cacheTtlMs ?? 5_000;
    this.#now = options.now ?? Date.now;
    if (!Number.isSafeInteger(this.#cacheTtlMs) || this.#cacheTtlMs < 0) {
      throw new TypeError("Runtime 元数据缓存时间无效");
    }
  }

  async resolve(runIds: readonly string[]): Promise<ReadonlyMap<string, RunDisplayMetadata>> {
    const requested = [...new Set(runIds.filter((runId) => identifierPattern.test(runId)))];
    if (requested.length === 0) return new Map();
    if (this.#now() >= this.#expiresAt) {
      this.#refreshing ??= this.#refresh().finally(() => {
        this.#refreshing = undefined;
      });
      await this.#refreshing;
    }
    const result = new Map<string, RunDisplayMetadata>();
    for (const runId of requested) {
      const metadata = this.#cache.get(runId);
      if (metadata !== undefined) result.set(runId, metadata);
    }
    return result;
  }

  async #refresh(): Promise<void> {
    const settled = await Promise.allSettled(actors.map((actor) => this.#loadActor(actor)));
    const next = new Map<string, RunDisplayMetadata>();
    let succeeded = false;
    for (const result of settled) {
      if (result.status !== "fulfilled") continue;
      succeeded = true;
      for (const [runId, metadata] of result.value) next.set(runId, metadata);
    }
    if (succeeded) this.#cache = next;
    this.#expiresAt = this.#now() + this.#cacheTtlMs;
  }

  async #loadActor(actor: Actor): Promise<ReadonlyMap<string, RunDisplayMetadata>> {
    const result = new Map<string, RunDisplayMetadata>();
    const tenantIds = new Set<string | undefined>([undefined]);
    try {
      const teams = await this.#requestItems("/v1/me/teams", actor);
      for (const team of teams) {
        const id = stringProperty(team, "id");
        if (id !== undefined && identifierPattern.test(id)) tenantIds.add(id);
      }
    } catch {
      // 个人 Tenant 仍可读取；团队列表不可用不应让整个查看器失效。
    }
    const tenantResults = await Promise.allSettled(
      [...tenantIds].map((tenantId) => this.#loadTenant(actor, tenantId)),
    );
    for (const tenantResult of tenantResults) {
      if (tenantResult.status !== "fulfilled") continue;
      for (const [runId, metadata] of tenantResult.value) result.set(runId, metadata);
    }
    return result;
  }

  async #loadTenant(
    actor: Actor,
    tenantId: string | undefined,
  ): Promise<ReadonlyMap<string, RunDisplayMetadata>> {
    const threads = await this.#listThreads(actor, tenantId);
    const runPages = await Promise.allSettled(
      threads.map(async (thread) => {
        const threadId = stringProperty(thread, "id");
        const title = stringProperty(thread, "title");
        if (
          threadId === undefined ||
          title === undefined ||
          !identifierPattern.test(threadId) ||
          title.trim() === ""
        ) {
          return [] as const;
        }
        const runs = await this.#requestItems(
          `/v1/threads/${encodeURIComponent(threadId)}/runs?limit=100`,
          actor,
          tenantId,
        );
        return runs.flatMap((run) => {
          const runId = stringProperty(run, "id");
          const createdAt = stringProperty(run, "createdAt");
          return runId === undefined || !identifierPattern.test(runId)
            ? []
            : [
                {
                  runId,
                  threadId,
                  title: title.trim(),
                  ...(createdAt === undefined ? {} : { createdAt }),
                } satisfies RunDisplayMetadata,
              ];
        });
      }),
    );
    const result = new Map<string, RunDisplayMetadata>();
    for (const page of runPages) {
      if (page.status !== "fulfilled") continue;
      for (const metadata of page.value) result.set(metadata.runId, metadata);
    }
    return result;
  }

  async #listThreads(actor: Actor, tenantId: string | undefined): Promise<readonly unknown[]> {
    const items: unknown[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const query = new URLSearchParams({ limit: "100" });
      if (cursor !== undefined) query.set("cursor", cursor);
      const data = await this.#requestData(`/v1/threads?${query.toString()}`, actor, tenantId);
      items.push(...arrayProperty(data, "items"));
      cursor = stringProperty(data, "nextCursor");
      if (cursor === undefined) return items;
    }
    return items;
  }

  async #requestItems(path: string, actor: Actor, tenantId?: string): Promise<readonly unknown[]> {
    return arrayProperty(await this.#requestData(path, actor, tenantId), "items");
  }

  async #requestData(path: string, actor: Actor, tenantId?: string): Promise<unknown> {
    const headers = new Headers({
      Accept: "application/json",
      Authorization: actor.authorization,
    });
    if (tenantId !== undefined) headers.set("X-Tenant-ID", tenantId);
    const response = await this.#fetcher(`${this.#origin}${path}`, { headers });
    if (!response.ok) throw new Error("RUNTIME_METADATA_UNAVAILABLE");
    const envelope: unknown = await response.json();
    return objectProperty(envelope, "data");
  }
}

function normalizeLoopbackOrigin(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "::1", "localhost"].includes(url.hostname) ||
    url.username !== "" ||
    url.password !== "" ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new TypeError("Runtime 元数据 API 必须是无凭据的回环 HTTP origin");
  }
  if (url.hostname === "localhost") url.hostname = "127.0.0.1";
  return url.origin;
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function objectProperty(value: unknown, key: string): unknown {
  return record(value)?.[key];
}

function arrayProperty(value: unknown, key: string): readonly unknown[] {
  const candidate = record(value)?.[key];
  return Array.isArray(candidate) ? candidate : [];
}

function stringProperty(value: unknown, key: string): string | undefined {
  const candidate = record(value)?.[key];
  return typeof candidate === "string" ? candidate : undefined;
}
