import type { RunDto } from "../src/index.js";

export function run(status: RunDto["status"] = "running"): RunDto {
  return {
    id: "run_sdk",
    threadId: "thread_sdk",
    tenantId: "tenant_sdk",
    status,
    createdAt: "2026-11-22T00:00:00.000Z",
    updatedAt: "2026-11-22T00:00:00.000Z",
  };
}

export function stream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

export function events(
  sequences: number[],
  status: RunDto["status"] = "running",
  attemptId = "attempt_sdk",
  payload: Record<string, unknown> = {},
  type = "message.delta",
): string {
  return `id: ${attemptId}-${sequences.at(-1) ?? 0}\nevent: run-events\ndata: ${JSON.stringify({
    run: run(status),
    page: {
      attemptId,
      hasMore: false,
      items: sequences.map((sequence) => ({
        eventId: `${attemptId}-${sequence}`,
        sequence,
        kind: "agent_event",
        type,
        payload,
        occurredAt: "2026-11-22T00:00:00.000Z",
      })),
    },
  })}\n\n`;
}

export const retry = { initialDelayMs: 1, maxDelayMs: 2, maxRetries: 3 };
export const sseResponse = (text: string) =>
  new Response(stream(text), { headers: { "content-type": "text/event-stream" } });
export const ok = (data: unknown) => Response.json({ version: "v1", requestId: "req_sdk", data });
