import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readCliTextFile, writeCliTextFile } from "./cli-files.js";

describe("CLI 显式文件边界", () => {
  it("有界读取 UTF-8，拒绝超限、非普通文件和无效编码", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hoox-cli-files-"));
    const file = join(directory, "input.yaml");
    try {
      await writeFile(file, "中文\n");
      expect(await readCliTextFile(file, 7)).toBe("中文\n");
      await expect(readCliTextFile(file, 6)).rejects.toThrow("CLI_FILE_TOO_LARGE");
      await expect(readCliTextFile(directory, 20)).rejects.toThrow("CLI_FILE_NOT_REGULAR");
      await writeFile(file, Buffer.from([0xff]));
      await expect(readCliTextFile(file, 20)).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it.skipIf(process.platform === "win32")("非阻塞拒绝没有写端的 FIFO", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hoox-cli-fifo-"));
    const fifo = join(directory, "input.yaml");
    try {
      execFileSync("mkfifo", [fifo]);
      await expect(readCliTextFile(fifo, 20)).rejects.toThrow("CLI_FILE_NOT_REGULAR");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("输出只创建新文件，不覆盖既有内容；权限默认不向其他用户开放", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hoox-cli-files-"));
    const file = join(directory, "out.yaml");
    try {
      await writeCliTextFile(file, "schemaVersion: 1\n");
      await expect(writeCliTextFile(file, "overwrite")).rejects.toThrow();
      expect(await readFile(file, "utf8")).toBe("schemaVersion: 1\n");
      if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
