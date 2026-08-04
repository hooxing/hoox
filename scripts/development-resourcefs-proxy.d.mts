import type { IncomingMessage, ServerResponse } from "node:http";

export const RESOURCE_FILESYSTEM_PATH_PREFIX: "/v1/resource-filesystem";

export interface DevelopmentResourceFsProxyOptions {
  readonly upstream: string;
  readonly upstreamTimeoutMs?: number;
}

export function createDevelopmentResourceFsProxyHandler(
  options: DevelopmentResourceFsProxyOptions,
): (request: IncomingMessage, response: ServerResponse) => void;

export function isResourceFilesystemPath(pathname: string): boolean;
