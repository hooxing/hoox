import { HeadObjectCommand, type PutObjectCommand } from "@aws-sdk/client-s3";

export type S3ConditionalWrite = "if-none-match" | "oss-forbid-overwrite";

export function parseS3ConditionalWrite(value: string): S3ConditionalWrite {
  if (value === "if-none-match" || value === "oss-forbid-overwrite") return value;
  throw new TypeError("S3 条件写入方式无效");
}

export function isOssEndpoint(endpoint: string | undefined): boolean {
  if (endpoint === undefined) return false;
  // 规范化单个 DNS 根标签尾点，避免 `*.aliyuncs.com.` 漏判而退回 OSS 不支持的 If-None-Match。
  const hostname = new URL(endpoint).hostname.replace(/\.$/u, "");
  return hostname.endsWith(".aliyuncs.com");
}

export function resolveS3ConditionalWrite(config: {
  readonly endpoint?: string;
  readonly conditionalWrite?: S3ConditionalWrite;
}): S3ConditionalWrite {
  return config.conditionalWrite === undefined
    ? isOssEndpoint(config.endpoint)
      ? "oss-forbid-overwrite"
      : "if-none-match"
    : parseS3ConditionalWrite(config.conditionalWrite);
}

export function applyS3ConditionalWrite(command: PutObjectCommand, mode: S3ConditionalWrite): void {
  if (mode === "if-none-match") {
    command.input.IfNoneMatch = "*";
    return;
  }
  command.middlewareStack.add(
    (next) => async (args) => {
      const request = args.request as { headers: Record<string, string> };
      request.headers["x-oss-forbid-overwrite"] = "true";
      return next(args);
    },
    { step: "build", name: "ossForbidOverwrite" },
  );
}

export function isS3ObjectAlreadyExists(error: unknown): boolean {
  const value = error as {
    readonly name?: string;
    readonly $metadata?: { readonly httpStatusCode?: number };
  } | null;
  return (
    value?.name === "PreconditionFailed" ||
    value?.$metadata?.httpStatusCode === 412 ||
    (value?.name === "FileAlreadyExists" && value.$metadata?.httpStatusCode === 409)
  );
}

export async function probeS3ObjectReadiness(
  client: { send(command: HeadObjectCommand): Promise<unknown> },
  bucket: string,
): Promise<void> {
  try {
    await client.send(
      new HeadObjectCommand({ Bucket: bucket, Key: "__hoox_readiness__/nonexistent" }),
    );
  } catch (error) {
    if (
      (error as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata?.httpStatusCode !==
      404
    )
      throw error;
  }
}
