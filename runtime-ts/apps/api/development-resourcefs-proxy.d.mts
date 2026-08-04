import type { IncomingMessage, ServerResponse } from "node:http";

export const RESOURCE_FILESYSTEM_PATH_PREFIX: "/v1/resource-filesystem";

export interface DevelopmentResourceFsProxyOptions {
  readonly upstream: string;
  readonly upstreamTimeoutMs?: number;
}

export interface DevelopmentResourceFsProxyServerOptions extends DevelopmentResourceFsProxyOptions {
  readonly listenHost: string;
  readonly listenPort: number;
  readonly privateKeyPath: string;
  readonly certificatePath: string;
}

export interface RunningDevelopmentResourceFsProxy {
  close(): Promise<void>;
  probe(): Promise<void>;
}

export function createDevelopmentResourceFsProxyHandler(
  options: DevelopmentResourceFsProxyOptions,
): (request: IncomingMessage, response: ServerResponse) => void;

export function isResourceFilesystemPath(pathname: string): boolean;

export function startDevelopmentResourceFsProxy(
  options: DevelopmentResourceFsProxyServerOptions,
): Promise<RunningDevelopmentResourceFsProxy>;
