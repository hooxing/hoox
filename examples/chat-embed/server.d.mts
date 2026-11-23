import type { IncomingMessage, ServerResponse } from "node:http";

export function createHooxProxy(options: {
  readonly apiOrigin: string;
  readonly apiKey: string;
  readonly appOrigin: string;
  readonly sessionToken: string;
  readonly endUserId: string;
  readonly fetcher?: typeof fetch;
}): (request: IncomingMessage, response: ServerResponse) => Promise<void>;
