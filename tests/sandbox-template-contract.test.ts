import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const dockerfile = readFileSync(
  new URL("../deploy/cubesandbox/agent-sandbox-pptx.Dockerfile", import.meta.url),
  "utf8",
);

describe("CubeSandbox PPTX 模板契约", () => {
  it("固定基础镜像摘要与 PPTX 运行时依赖版本", () => {
    expect(dockerfile).toMatch(/^FROM .+@sha256:[a-f0-9]{64}$/mu);
    expect(dockerfile).toContain("nodejs");
    expect(dockerfile).toContain("libreoffice-impress");
    expect(dockerfile).toContain("poppler-utils");

    for (const dependency of [
      "pptxgenjs@3.12.0",
      "react@18.3.1",
      "react-dom@18.3.1",
      "react-icons@5.4.0",
      "sharp@0.33.5",
    ]) {
      expect(dockerfile).toContain(dependency);
    }
  });

  it("在镜像构建期验证命令与 Node 模块", () => {
    expect(dockerfile).toContain("ln -s /usr/local/lib/node_modules /node_modules");
    expect(dockerfile).toContain("require(name)");
    expect(dockerfile).toContain("command -v soffice");
    expect(dockerfile).toContain("command -v pdftoppm");
  });
});
