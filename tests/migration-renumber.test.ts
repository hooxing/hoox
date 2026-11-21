import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { devNull, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../scripts/migration-renumber.mjs", import.meta.url));
const migrations = "runtime-ts/packages/persistence/migrations";
const gitEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
  GIT_CONFIG_GLOBAL: devNull,
  GIT_CONFIG_NOSYSTEM: "1",
};

let root: string;

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: root, env: gitEnv, encoding: "utf8" }).trim();
}

function commit(message: string): void {
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    message,
  );
}

function run(...args: string[]) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    env: gitEnv,
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  return result;
}

function write(file: string, text: string | Buffer): void {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), text);
}

function read(file: string): string {
  return readFileSync(join(root, file), "utf8");
}

function pair(stem: string, up = `-- ${stem}\n`): void {
  write(`${migrations}/${stem}.up.sql`, up);
  write(`${migrations}/${stem}.down.sql`, "-- down\n");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hoox-migration-renumber-"));
  git("init", "-q", "-b", "main");
  for (let version = 1; version <= 11; version++) {
    pair(`${String(version).padStart(4, "0")}_base`, "-- 0011_x 不改写基准 SQL 中的引用\n");
  }
  write(".gitattributes", "*.sql text eol=lf\n");
  git("add", "--", ".");
  commit("基准迁移");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("migration:renumber", () => {
  it("顺延冲突版本，保留基准迁移和文件跟踪状态，只改写指定目录中的完整主干", () => {
    pair("0011_x", "-- 依赖见 0012_y.up.sql\n");
    git("add", "--", migrations);
    commit("已跟踪的分支迁移");
    pair("0012_y");
    const reference = "0011_x.up.sql + 0012_y.down.sql，保留 pre0011_x、0012_y_extra 和 0011_X\n";
    const updated = "0012_x.up.sql + 0013_y.down.sql，保留 pre0011_x、0012_y_extra 和 0011_X\n";
    const files = [
      "tests/ref.ts",
      "runtime-ts/app/ref.ts",
      "docs/ref with space.md",
      ".github/ref.yml",
      "scripts/ref.mjs",
    ];
    for (const file of files) write(file, reference);
    git("add", "--", "docs/ref with space.md");
    const skipped = [
      "README.md",
      "runtime-ts/app/dist/ref.js",
      "runtime-ts/app/node_modules/ref.js",
      "runtime-ts/vendor/ref.ts",
      "tests/ignored.txt",
    ];
    write(".gitignore", "tests/ignored.txt\n");
    for (const file of skipped) write(file, reference);
    const binary = Buffer.from("0011_x\0");
    write("tests/binary.bin", binary);

    const result = run();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("0011_x → 0012_x");
    expect(result.stdout).toContain("0012_y → 0013_y");
    expect(result.stdout).toContain("更新引用：docs/ref with space.md");
    expect(read(`${migrations}/0012_x.up.sql`)).toBe("-- 依赖见 0013_y.up.sql\n");
    expect(read(`${migrations}/0013_y.up.sql`)).toBe("-- 0013_y\n");
    expect(read(`${migrations}/0012_x.down.sql`)).toBe("-- down\n");
    expect(read(`${migrations}/0013_y.down.sql`)).toBe("-- down\n");
    expect(existsSync(join(root, migrations, "0011_x.up.sql"))).toBe(false);
    expect(existsSync(join(root, migrations, "0012_y.down.sql"))).toBe(false);
    expect(git("diff", "origin/main", "--", `${migrations}/*_base.*.sql`)).toBe("");
    expect(git("diff", "--cached", "origin/main", "--", `${migrations}/*_base.*.sql`)).toBe("");
    expect(git("ls-files", "--", `${migrations}/0012_x.*.sql`)).toContain("0012_x.down.sql");
    expect(git("ls-files", "--", `${migrations}/0013_y.*.sql`)).toBe("");
    for (const file of files) expect(read(file)).toBe(updated);
    for (const file of skipped) expect(read(file)).toBe(reference);
    expect(readFileSync(join(root, "tests/binary.bin"))).toEqual(binary);
    const repeated = run();
    expect(repeated.status).toBe(0);
    expect(repeated.stdout.trim()).toBe("无需重编号");
  });

  it("按版本再按名称排序，先腾开同名文件占用的目标且引用不级联", () => {
    pair("0011_x", "-- first\n");
    pair("0011_a", "-- a\n");
    pair("0013_x", "-- second\n");
    pair("0020_z", "-- z\n");
    write("tests/references.txt", "0011_x 0013_x 0011_a 0020_z\n");
    git("add", "--", `${migrations}/0013_x.*.sql`);

    const result = run("HEAD");
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(read(`${migrations}/0012_a.up.sql`)).toBe("-- a\n");
    expect(read(`${migrations}/0013_x.up.sql`)).toBe("-- first\n");
    expect(read(`${migrations}/0014_x.up.sql`)).toBe("-- second\n");
    expect(read(`${migrations}/0015_z.up.sql`)).toBe("-- z\n");
    expect(read("tests/references.txt")).toBe("0013_x 0014_x 0012_a 0015_z\n");
  });

  it("预演列出迁移和引用变更，不写工作区或 Git 索引", () => {
    pair("0011_x");
    git("add", "--", migrations);
    write("tests/ref.ts", "0011_x");
    const staged = git("ls-files", "--stage");
    const names = readdirSync(join(root, migrations));

    const result = run("--dry-run", "HEAD");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("预演");
    expect(result.stdout).toContain("0011_x → 0012_x");
    expect(result.stdout).toContain("更新引用：tests/ref.ts");
    expect(git("ls-files", "--stage")).toBe(staged);
    expect(readdirSync(join(root, migrations))).toEqual(names);
    expect(read("tests/ref.ts")).toBe("0011_x");
    expect(read(`${migrations}/0011_x.up.sql`)).toBe("-- 0011_x\n");
  });

  it.each(["工作区", "仅索引中", "已提交", "删除", "仅换行变化"])(
    "拒绝基准迁移被改动：%s",
    (kind) => {
      const path = `${migrations}/0001_base.down.sql`;
      const original = read(path);
      if (kind === "删除") rmSync(join(root, path));
      else write(path, kind === "仅换行变化" ? original.replaceAll("\n", "\r\n") : "-- changed\n");
      if (kind === "仅索引中" || kind === "已提交") git("add", "--", path);
      if (kind === "仅索引中") write(path, original);
      if (kind === "已提交") commit("改动基准迁移");
      pair("0011_x");

      const result = run();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`已合并迁移不可修改：${path}`);
      expect(existsSync(join(root, migrations, "0011_x.up.sql"))).toBe(true);
      expect(existsSync(join(root, migrations, "0012_x.up.sql"))).toBe(false);
    },
  );

  it("在改动任何迁移或引用前拒绝未成对的迁移", () => {
    pair("0011_x");
    write(`${migrations}/0012_y.up.sql`, "-- up\n");
    write("tests/ref.ts", "0011_x");

    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("迁移未成对：0012_y");
    expect(read("tests/ref.ts")).toBe("0011_x");
    expect(existsSync(join(root, migrations, "0011_x.up.sql"))).toBe(true);
    expect(existsSync(join(root, migrations, "0012_x.up.sql"))).toBe(false);
  });
});

describe("migration:new", () => {
  it("取基准与工作区最大编号的下一号，创建未暂存且只有中文注释的成对文件", () => {
    for (const direction of ["up", "down"])
      rmSync(join(root, migrations, `0011_base.${direction}.sql`));
    const first = run("--new", "first_2");
    expect(first.stderr).toBe("");
    expect(first.status).toBe(0);
    expect(read(`${migrations}/0012_first_2.up.sql`)).toMatch(
      /^-- .*向前迁移。\n-- .*不可修改.*\n$/,
    );
    expect(read(`${migrations}/0012_first_2.down.sql`)).toMatch(/^-- .*回退.*\n-- .*不可修改.*\n$/);

    pair("0018_draft");
    const second = run("--new", "second");
    expect(second.status).toBe(0);
    expect(second.stdout).toContain("0019_second.up.sql");
    expect(second.stdout).toContain("0019_second.down.sql");
    expect(git("ls-files", "--", `${migrations}/0019_second.*.sql`)).toBe("");
  });

  it("拒绝非法名称，不创建迁移文件", () => {
    const names = readdirSync(join(root, migrations));
    const result = run("--new", "Bad/Name");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("迁移名称只允许小写字母、数字和下划线");
    expect(readdirSync(join(root, migrations))).toEqual(names);
  });
});
