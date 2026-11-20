import type { FastifyRequest } from "fastify";
import { ApiFailure } from "./service.js";

const idempotencyKeyPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;

export function requestId(request: FastifyRequest): string {
  return String(request.id);
}

export function headerValues(request: FastifyRequest, name: string): readonly string[] {
  const rawHeaders = request.raw.rawHeaders;
  if (Array.isArray(rawHeaders)) {
    const values: string[] = [];
    for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
      if (rawHeaders[index]?.toLowerCase() === name) {
        const value = rawHeaders[index + 1];
        if (value !== undefined) values.push(value);
      }
    }
    return values;
  }
  const value = request.headers[name];
  if (typeof value === "string") return [value];
  return Array.isArray(value) ? value : [];
}

export function requireIdempotencyKey(request: FastifyRequest): string {
  const value = request.headers["idempotency-key"];
  if (typeof value !== "string" || !idempotencyKeyPattern.test(value)) {
    throw new ApiFailure("bad_request");
  }
  return value;
}

export function requireJsonContentType(request: FastifyRequest): void {
  const value = request.headers["content-type"];
  if (
    typeof value !== "string" ||
    value.split(";", 1)[0]?.trim().toLowerCase() !== "application/json"
  ) {
    throw new ApiFailure("unsupported_media_type");
  }
}

export function success<T>(request: FastifyRequest, data: T) {
  return { version: "v1" as const, requestId: requestId(request), data };
}
