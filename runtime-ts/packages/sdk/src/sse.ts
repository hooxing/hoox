import { HooxError } from "./errors.js";

export type SseFrame = { event: string; data: string; id?: string };

export async function* parseSse(stream: ReadableStream<Uint8Array>): AsyncGenerator<SseFrame> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let event = "message";
  let id: string | undefined;
  let data: string[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      while (true) {
        const match = /\r\n|\r|\n/u.exec(buffer);
        if (!match) break;
        if (!chunk.done && match[0] === "\r" && match.index === buffer.length - 1) break;
        const line = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        size += line.length;
        if (size > 8_388_608) throw new HooxError("SSE 帧超过大小限制", "INVALID_STREAM");
        if (line === "") {
          if (data.length > 0) {
            yield { event, data: data.join("\n"), ...(id === undefined ? {} : { id }) };
          }
          event = "message";
          id = undefined;
          data = [];
          size = 0;
        } else if (!line.startsWith(":")) {
          const separator = line.indexOf(":");
          const field = separator === -1 ? line : line.slice(0, separator);
          const raw = separator === -1 ? "" : line.slice(separator + 1);
          const value = raw.startsWith(" ") ? raw.slice(1) : raw;
          if (field === "event") event = value;
          if (field === "data") data.push(value);
          if (field === "id" && !value.includes("\0")) id = value;
        }
      }
      if (buffer.length + size > 8_388_608) {
        throw new HooxError("SSE 帧超过大小限制", "INVALID_STREAM");
      }
      if (chunk.done) return;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
