import { access, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const workspaceRoots = ["apps", "packages", "vendor"].map((directory) =>
  path.join(repositoryRoot, "runtime-ts", directory),
);

const generatedDirectories = [];
for (const workspaceRoot of workspaceRoots) {
  for (const entry of await readdir(workspaceRoot, { withFileTypes: true })) {
    // 只处理仓库中直接声明的真实目录；符号链接不能扩大清理边界。
    if (!entry.isDirectory()) continue;
    const packageDirectory = path.resolve(workspaceRoot, entry.name);
    try {
      await access(path.join(packageDirectory, "package.json"));
    } catch {
      continue;
    }
    const generatedDirectory = path.join(packageDirectory, "dist");
    if (
      path.dirname(generatedDirectory) !== packageDirectory ||
      path.basename(generatedDirectory) !== "dist" ||
      path.dirname(packageDirectory) !== workspaceRoot
    ) {
      throw new Error(`拒绝删除未通过边界校验的生成目录：${generatedDirectory}`);
    }
    generatedDirectories.push(generatedDirectory);
  }
}

await Promise.all(
  generatedDirectories.map((generatedDirectory) =>
    rm(generatedDirectory, { recursive: true, force: true }),
  ),
);
console.log(`已清理 ${generatedDirectories.length} 个工作区 dist 目录，开始验证全新检出构建顺序`);
