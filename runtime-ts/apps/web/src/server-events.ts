/** 有界 SSE 解码器；UTF-8、行和帧边界均允许跨网络分片。 */
export async function* readServerEvents(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = "";
  let event = "message";
  let data: string[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) {
        pending += decoder.decode();
        if (pending.trim().length > 0 || data.length > 0) throw new Error("事件流在帧中间结束");
        return;
      }
      pending += decoder.decode(chunk.value, { stream: true });
      if (pending.length + size > 8 * 1024 * 1024) throw new Error("事件流帧超出大小上限");
      for (;;) {
        const newline = pending.indexOf("\n");
        if (newline < 0) break;
        const line = pending.slice(0, newline).replace(/\r$/u, "");
        pending = pending.slice(newline + 1);
        if (line === "") {
          if (data.length > 0) yield { event, data: JSON.parse(data.join("\n")) as unknown };
          event = "message";
          data = [];
          size = 0;
        } else if (line.startsWith("event:")) event = line.slice(6).trimStart();
        else if (line.startsWith("data:")) {
          const value = line.slice(5).replace(/^ /u, "");
          data.push(value);
          size += value.length;
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
