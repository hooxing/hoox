import { open, writeFile } from "node:fs/promises";

export async function readCliTextFile(path: string, maximumBytes: number): Promise<string> {
  const file = await open(path, "r");
  try {
    if (!(await file.stat()).isFile()) throw new Error("CLI_FILE_NOT_REGULAR");
    const buffer = Buffer.alloc(maximumBytes + 1);
    let size = 0;
    while (size < buffer.length) {
      const result = await file.read(buffer, size, buffer.length - size, null);
      if (result.bytesRead === 0) break;
      size += result.bytesRead;
    }
    if (size > maximumBytes) throw new Error("CLI_FILE_TOO_LARGE");
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size));
  } finally {
    await file.close();
  }
}

export async function writeCliTextFile(path: string, content: string): Promise<void> {
  await writeFile(path, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
}
