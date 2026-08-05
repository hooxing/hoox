import type {
  CreateSkillSubmissionRequest,
  PublishSkillSubmissionRequest,
  ReviewSkillSubmissionRequest,
  RevokeSkillSubmissionRequest,
  SkillSubmissionDto,
  SkillSubmissionFileRequest,
  SkillSubmissionPageDto,
  SubmitSkillSubmissionRequest,
} from "@cube-runtime/protocol";

type SuccessEnvelope<T> = {
  readonly version: "v1";
  readonly requestId: string;
  readonly data: T;
};

type ErrorEnvelope = {
  readonly error?: {
    readonly code?: string;
    readonly retryable?: boolean;
  };
};

const defaultFetcher: typeof fetch = (input, init) => globalThis.fetch(input, init);

export class AdminApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "AdminApiError";
  }
}

function safeErrorMessage(status: number): string {
  if (status === 400 || status === 422) return "提交内容不符合要求，请检查后重试。";
  if (status === 401) return "登录状态已失效，请重新登录。";
  if (status === 403) return "当前账号没有执行此操作的权限。";
  if (status === 404) return "发布申请不存在或已被移除。";
  if (status === 409) return "申请状态已发生变化，请刷新后重试。";
  if (status === 413) return "技能包超过服务允许的大小。";
  if (status === 429) return "操作过于频繁，请稍后重试。";
  return "管理服务暂时不可用，请稍后重试。";
}

function unwrap<T>(value: unknown): T {
  if (typeof value !== "object" || value === null || !("data" in value)) {
    throw new AdminApiError("管理服务返回了无法识别的数据。", 502, true);
  }
  return (value as SuccessEnvelope<T>).data;
}

function defaultIdempotencyKey(): string {
  return crypto.randomUUID();
}

export class SkillAdminApi {
  private readonly pendingIdempotencyKeys = new Map<string, string>();

  constructor(
    private readonly fetcher: typeof fetch = defaultFetcher,
    private readonly baseUrl = "/v1/admin/skill-submissions",
    private readonly createIdempotencyKey: () => string = defaultIdempotencyKey,
  ) {}

  private async request<T>(path = "", init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    if (init.body !== undefined) headers.set("Content-Type", "application/json");
    const method = init.method ?? "GET";
    let requestFingerprint: string | undefined;
    if (method !== "GET" && method !== "HEAD") {
      requestFingerprint = await fingerprintWriteRequest(method, path, init.body);
      let idempotencyKey = this.pendingIdempotencyKeys.get(requestFingerprint);
      if (idempotencyKey === undefined) {
        idempotencyKey = this.createIdempotencyKey();
        if (this.pendingIdempotencyKeys.size >= 32) {
          const oldest = this.pendingIdempotencyKeys.keys().next().value;
          if (oldest !== undefined) this.pendingIdempotencyKeys.delete(oldest);
        }
        this.pendingIdempotencyKeys.set(requestFingerprint, idempotencyKey);
      }
      // 网络失败或提交结果未知后，相同 method/path/body 的人工重试仍保持同一请求身份。
      headers.set("Idempotency-Key", idempotencyKey);
    }

    let response: Response;
    try {
      response = await this.fetcher(`${this.baseUrl}${path}`, {
        ...init,
        credentials: "same-origin",
        headers,
      });
    } catch {
      throw new AdminApiError("无法连接管理服务，请检查网络后重试。", 0, true);
    }

    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const error = body as ErrorEnvelope | undefined;
      if (requestFingerprint !== undefined && error?.error?.retryable !== true) {
        this.pendingIdempotencyKeys.delete(requestFingerprint);
      }
      // 服务端 message 可能含内部定位信息，管理员界面仅按稳定 HTTP 语义展示安全文案。
      throw new AdminApiError(
        safeErrorMessage(response.status),
        response.status,
        error?.error?.retryable ?? response.status >= 500,
      );
    }
    if (requestFingerprint !== undefined) {
      this.pendingIdempotencyKeys.delete(requestFingerprint);
    }
    return unwrap<T>(body);
  }

  listSubmissions(cursor?: string): Promise<SkillSubmissionPageDto> {
    const query = new URLSearchParams({ limit: "100" });
    if (cursor !== undefined) query.set("cursor", cursor);
    return this.request(`?${query.toString()}`);
  }

  getSubmission(submissionId: string): Promise<SkillSubmissionDto> {
    return this.request(`/${encodeURIComponent(submissionId)}`);
  }

  createSubmission(input: CreateSkillSubmissionRequest): Promise<SkillSubmissionDto> {
    return this.request("", { method: "POST", body: JSON.stringify(input) });
  }

  submitSubmission(
    submissionId: string,
    input: SubmitSkillSubmissionRequest,
  ): Promise<SkillSubmissionDto> {
    return this.request(`/${encodeURIComponent(submissionId)}/submit`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  reviewSubmission(
    submissionId: string,
    input: ReviewSkillSubmissionRequest,
  ): Promise<SkillSubmissionDto> {
    return this.request(`/${encodeURIComponent(submissionId)}/review`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  publishSubmission(
    submissionId: string,
    input: PublishSkillSubmissionRequest,
  ): Promise<SkillSubmissionDto> {
    return this.request(`/${encodeURIComponent(submissionId)}/publish`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  revokeSubmission(
    submissionId: string,
    input: RevokeSkillSubmissionRequest,
  ): Promise<SkillSubmissionDto> {
    return this.request(`/${encodeURIComponent(submissionId)}/revoke`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }
}

async function fingerprintWriteRequest(
  method: string,
  path: string,
  body: BodyInit | null | undefined,
): Promise<string> {
  if (body !== undefined && body !== null && typeof body !== "string") {
    throw new AdminApiError("管理请求正文格式无效。", 400, false);
  }
  const bytes = new TextEncoder().encode(`${method}\n${path}\n${body ?? ""}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (value) => value.toString(16).padStart(2, "0")).join("");
}

export function resolvePackagePath(file: File): string {
  const relativePath = file.webkitRelativePath?.trim() ?? "";
  return (relativePath.length > 0 ? relativePath : file.name).replaceAll("\\", "/");
}

export function resolvePackagePaths(files: readonly File[]): readonly string[] {
  const selectedPaths = files.map(resolvePackagePath);
  const firstRoot = selectedPaths[0]?.split("/", 1)[0];
  const hasDirectoryPickerRoot =
    firstRoot !== undefined &&
    firstRoot.length > 0 &&
    selectedPaths.every((path) => path.startsWith(`${firstRoot}/`));
  // webkitdirectory 会把用户选中的目录名附在每个相对路径前；包协议要求根目录本身不入包。
  return selectedPaths.map((path) =>
    hasDirectoryPickerRoot ? path.slice(firstRoot.length + 1) : path,
  );
}

function encodeBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
  }
  return btoa(chunks.join(""));
}

export async function filesToRequests(
  files: readonly File[],
): Promise<readonly SkillSubmissionFileRequest[]> {
  const packagePaths = resolvePackagePaths(files);
  const paths = new Set<string>();
  return Promise.all(
    files.map(async (file, index) => {
      const path = packagePaths[index];
      if (path === undefined || path.length === 0) {
        throw new AdminApiError("技能包文件路径无效。", 400, false);
      }
      if (paths.has(path)) throw new AdminApiError(`存在重复文件路径：${path}`, 400, false);
      if (file.size === 0) throw new AdminApiError(`文件不能为空：${path}`, 400, false);
      paths.add(path);
      return {
        path,
        mediaType: file.type.trim() || "application/octet-stream",
        contentBase64: encodeBase64(await file.arrayBuffer()),
      };
    }),
  );
}

export type SkillAdminApiContract = Pick<
  SkillAdminApi,
  | "createSubmission"
  | "getSubmission"
  | "listSubmissions"
  | "publishSubmission"
  | "reviewSubmission"
  | "revokeSubmission"
  | "submitSubmission"
>;
