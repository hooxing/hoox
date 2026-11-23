import { describe, expect, it } from "vitest";
import { parseSse } from "../src/sse.js";
import { stream } from "./fixtures.js";

describe("SDK SSE 解析", () => {
  it("在任意字节边界解析 UTF-8、BOM、CRLF、CR、多行 data 和注释", async () => {
    const text =
      "\uFEFF:心跳\r\nid: attempt-1\r\nevent: run-events\rdata: 上海\ndata: 第二行\r\n\r\n";
    const bytes = new TextEncoder().encode(text);
    for (let split = 1; split < bytes.length; split += 1) {
      const input = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes.slice(0, split));
          controller.enqueue(bytes.slice(split));
          controller.close();
        },
      });
      const frames = [];
      for await (const frame of parseSse(input)) frames.push(frame);
      expect(frames).toEqual([{ id: "attempt-1", event: "run-events", data: "上海\n第二行" }]);
    }
  });

  it("忽略无 data、无效 ID 及未以空行完成的尾帧", async () => {
    const frames = [];
    for await (const frame of parseSse(
      stream("id: unused\n\nid: bad\0id\ndata: ok\n\ndata: lost"),
    )) {
      frames.push(frame);
    }
    expect(frames).toEqual([{ event: "message", data: "ok" }]);
  });

  it("提前退出时取消 reader，并限制未完成帧内存", async () => {
    let cancelled = false;
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: one\n\ndata: two\n\n"));
      },
      cancel() {
        cancelled = true;
      },
    });
    for await (const frame of parseSse(input)) {
      expect(frame.data).toBe("one");
      break;
    }
    expect(cancelled).toBe(true);
    await expect(parseSse(stream("x".repeat(8_388_609))).next()).rejects.toMatchObject({
      code: "INVALID_STREAM",
    });
  });
});
