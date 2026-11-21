import { isUtf8 } from "node:buffer";
import { execFileSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

const migrationDir = "runtime-ts/packages/persistence/migrations";
const referenceDirs = ["tests", "runtime-ts", "docs", ".github", "scripts"];
const migrationPattern = /^((\d{4})_([a-z0-9_]+))\.(up|down)\.sql$/;
const directions = ["up", "down"];

function git(args, cwd, input) {
  return execFileSync("git", args, {
    cwd,
    input,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  }).toString("utf8");
}

function gitPathEntries(output) {
  return output
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const tab = entry.indexOf("\t");
      return [entry.slice(tab + 1), entry.slice(0, tab).split(" ")];
    });
}

function parseMigration(path) {
  const match = migrationPattern.exec(path.slice(migrationDir.length + 1));
  if (match === null) throw new Error(`无法识别迁移文件：${path}`);
  const [, stem, version, name, direction] = match;
  return { stem, version: Number(version), name, direction };
}

function migrationPath(stem, direction) {
  return `${migrationDir}/${stem}.${direction}.sql`;
}

function numberedStem(version, name) {
  if (version > 9999) throw new Error("迁移编号已超出四位数范围");
  return `${String(version).padStart(4, "0")}_${name}`;
}

function readBaseline(root, ref) {
  let tree;
  try {
    tree = git(["rev-parse", "--verify", "--end-of-options", `${ref}^{tree}`], root).trim();
  } catch {
    throw new Error(`找不到迁移基准引用：${ref}`);
  }
  return new Map(
    gitPathEntries(
      git(["ls-tree", "-z", "--full-tree", tree, "--", `${migrationDir}/`], root),
    ).filter(([path]) => path.endsWith(".sql")),
  );
}

function readWorkspace(root) {
  let directory = root;
  for (const part of migrationDir.split("/")) {
    directory = join(directory, part);
    const entry = lstatSync(directory, { throwIfNoEntry: false });
    if (!entry) return [];
    if (!entry.isDirectory()) throw new Error("迁移目录必须是普通目录，不能经过符号链接");
  }
  return readdirSync(directory)
    .filter((file) => file.endsWith(".sql"))
    .map((file) => `${migrationDir}/${file}`);
}

function maxVersion(paths) {
  let max = 0;
  for (const path of paths) max = Math.max(max, parseMigration(path).version);
  return max;
}

function verifyBaseline(root, baseline, index) {
  const paths = [...baseline.keys()];
  if (paths.length === 0) return;
  for (const [path, [mode, type, oid]] of baseline) {
    parseMigration(path);
    const staged = index.get(path);
    if (
      type !== "blob" ||
      !["100644", "100755"].includes(mode) ||
      staged?.[0] !== mode ||
      staged[1] !== oid ||
      staged[2] !== "0" ||
      !lstatSync(join(root, path), { throwIfNoEntry: false })?.isFile()
    ) {
      throw new Error(`已合并迁移不可修改：${path}；请确认工作区已包含基准迁移`);
    }
  }
  // checksum 绑定工作区的原始字节；不能用会应用换行过滤的 Git 比较替代。
  const worktreeOids = git(
    ["hash-object", "--no-filters", "--stdin-paths"],
    root,
    `${paths.join("\n")}\n`,
  )
    .trim()
    .split("\n");
  for (const [position, path] of paths.entries()) {
    if (worktreeOids[position] !== baseline.get(path)[2]) {
      throw new Error(`已合并迁移不可修改：${path}`);
    }
  }
}

function planMoves(root, paths, baseline, index) {
  const workspace = new Set(paths);
  const pairs = new Map();
  for (const path of workspace) {
    if (baseline.has(path)) continue;
    const { stem, name } = parseMigration(path);
    pairs.set(stem, name);
    if (!lstatSync(join(root, path)).isFile()) throw new Error(`迁移文件必须是普通文件：${path}`);
  }
  const baselineMax = maxVersion(baseline.keys());
  const moves = new Map();
  // 固定宽度版本号使主干的字典序等价于先按版本、再按名称排序。
  for (const [position, stem] of [...pairs.keys()].sort().entries()) {
    if (!directions.every((direction) => workspace.has(migrationPath(stem, direction)))) {
      throw new Error(`迁移未成对：${stem}`);
    }
    const target = numberedStem(baselineMax + position + 1, pairs.get(stem));
    if (target !== stem) moves.set(stem, target);
  }
  for (const path of index.keys()) {
    if (path.endsWith(".sql") && !workspace.has(path))
      throw new Error(`工作区缺少迁移文件：${path}`);
  }
  for (const target of moves.values()) {
    if (moves.has(target)) continue;
    for (const direction of directions) {
      const path = migrationPath(target, direction);
      if (index.has(path) || lstatSync(join(root, path), { throwIfNoEntry: false })) {
        throw new Error(`迁移目标已存在：${path}`);
      }
    }
  }
  return moves;
}

function planReferences(root, baseline, moves) {
  const files = git(
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...referenceDirs],
    root,
  );
  const updates = [];
  for (const file of new Set(files.split("\0").filter(Boolean))) {
    if (
      baseline.has(file) ||
      file.startsWith("runtime-ts/vendor/") ||
      file.split("/").some((part) => part === "node_modules" || part === "dist")
    )
      continue;
    const path = join(root, file);
    if (!lstatSync(path, { throwIfNoEntry: false })?.isFile() || realpathSync(path) !== path)
      continue;
    const bytes = readFileSync(path);
    if (bytes.includes(0) || !isUtf8(bytes)) continue;
    const original = bytes.toString("utf8");
    // 单次替换，避免目标恰好是另一条旧主干时被替换两次。
    const updated = original.replace(/\b\d{4}_[a-z0-9_]+\b/g, (stem) => moves.get(stem) ?? stem);
    if (updated === original) continue;
    const migration =
      file.startsWith(`${migrationDir}/`) &&
      migrationPattern.test(file.slice(migrationDir.length + 1))
        ? parseMigration(file)
        : undefined;
    const target = migration && moves.get(migration.stem);
    updates.push([target ? migrationPath(target, migration.direction) : file, updated]);
  }
  return updates;
}

function renumber(root, ref, dryRun) {
  const baseline = readBaseline(root, ref);
  const paths = readWorkspace(root);
  const index = new Map(
    gitPathEntries(git(["ls-files", "--stage", "-z", "--", migrationDir], root)),
  );
  verifyBaseline(root, baseline, index);
  if ([...index.values()].some(([, , stage]) => stage !== "0")) {
    throw new Error("请先解决迁移文件的 Git 冲突");
  }
  const moves = planMoves(root, paths, baseline, index);
  if (moves.size === 0) {
    console.log("无需重编号");
    return;
  }
  const updates = planReferences(root, baseline, moves);
  if (!dryRun) {
    const entries = [...moves];
    // 向下移从小到大，向上移从大到小，先腾出可能被同名迁移占用的目标。
    const ordered = [
      ...entries.filter(([from, to]) => to < from),
      ...entries.filter(([from, to]) => to > from).reverse(),
    ];
    for (const [from, to] of ordered) {
      for (const direction of directions) {
        const source = migrationPath(from, direction);
        const target = migrationPath(to, direction);
        if (index.has(source)) git(["mv", "--", source, target], root);
        else renameSync(join(root, source), join(root, target));
      }
    }
    for (const [path, contents] of updates) writeFileSync(join(root, path), contents);
  }
  console.log(dryRun ? "预演：不会写入工作区或 Git 索引" : "迁移重编号完成");
  for (const [from, to] of moves) console.log(`${from} → ${to}（up/down）`);
  for (const [path] of updates) console.log(`更新引用：${path}`);
}

function createMigration(root, name) {
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error("迁移名称只允许小写字母、数字和下划线");
  const baseline = readBaseline(root, "origin/main");
  const version = Math.max(maxVersion(baseline.keys()), maxVersion(readWorkspace(root))) + 1;
  const stem = numberedStem(version, name);
  mkdirSync(join(root, migrationDir), { recursive: true });
  const created = [];
  try {
    for (const direction of directions) {
      const path = migrationPath(stem, direction);
      const purpose =
        direction === "up"
          ? "在此编写向前迁移。"
          : "在此编写对应的回退；无法安全回退时应明确失败。";
      writeFileSync(
        join(root, path),
        `-- ${name}：${purpose}\n-- 已合并或执行的迁移不可修改；新变化必须追加迁移。\n`,
        { flag: "wx" },
      );
      created.push(path);
    }
  } catch (error) {
    for (const path of created) unlinkSync(join(root, path));
    throw error;
  }
  for (const path of created) console.log(`创建迁移：${path}`);
}

try {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { "dry-run": { type: "boolean" }, new: { type: "string" } },
  });
  const root = realpathSync(git(["rev-parse", "--show-toplevel"]).trimEnd());
  if (values.new !== undefined && positionals.length === 0 && !values["dry-run"]) {
    createMigration(root, values.new);
  } else if (values.new === undefined && positionals.length <= 1) {
    renumber(root, positionals[0] ?? "origin/main", values["dry-run"]);
  } else {
    throw new Error(
      "用法：pnpm migration:renumber [基准引用] [--dry-run] 或 pnpm migration:new <名称>",
    );
  }
} catch (error) {
  console.error(error.stderr?.toString().trim() || error.message);
  process.exitCode = 1;
}
