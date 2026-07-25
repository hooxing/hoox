import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const vendorRoot = path.join(repositoryRoot, "runtime-ts", "vendor", "cubesandbox-sdk");
const generatedDist = path.join(vendorRoot, "dist");

// 回归脚本只能删除固定 vendor 下的生成目录，绝不接受环境变量、参数或通配符目标。
if (path.dirname(generatedDist) !== vendorRoot || path.basename(generatedDist) !== "dist") {
  throw new Error("拒绝删除未通过边界校验的生成目录");
}

await rm(generatedDist, { recursive: true, force: true });
console.log("已删除 CubeSandbox SDK 生成目录，开始验证 clean checkout 构建顺序");
