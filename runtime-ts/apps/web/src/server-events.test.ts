import { describe, expect, it, vi } from "vitest";
import { readServerEvents } from "./server-events.js";

function bytes(source: string, chunkSize: number) {
  const data = new TextEncoder().encode(source);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (let index = 0; index < data.length; index += chunkSize)
        controller.enqueue(data.slice(index, index + chunkSize));
      controller.close();
    },
  });
}
async function collect(body: ReadableStream<Uint8Array>) {
  const result = [];
  for await (const item of readServerEvents(body)) result.push(item);
  return result;
}
describe("SSE 字节解码", () => {
  it.each([1, 2, 7, 1000])("分片大小 %i 下保留中文、emoji、CRLF 和多个事件", async (chunkSize) => {
    expect(
      await collect(
        bytes(
          ': heartbeat\r\nevent: run-events\r\ndata: {"text":"中文🧑‍💻"}\r\n\r\nevent: end\ndata: {"reason":"settled"}\n\n',
          chunkSize,
        ),
      ),
    ).toEqual([
      { event: "run-events", data: { text: "中文🧑‍💻" } },
      { event: "end", data: { reason: "settled" } },
    ]);
  });
  it("截断帧和损坏 UTF-8 不能被当成正常完成", async () => {
    await expect(collect(bytes('data: {"text":"半段"}', 3))).rejects.toThrow("帧中间");
    const invalid = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0xff]));
        controller.close();
      },
    });
    await expect(collect(invalid)).rejects.toThrow();
  });
  it("消费者结束会取消底层流并释放 reader", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: {}\n\n"));
      },
      cancel,
    });
    for await (const _event of readServerEvents(body)) break;
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });
});
