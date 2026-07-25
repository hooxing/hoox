import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

describe("领域实体名义类型编译契约", () => {
  it("对象展开后篡改状态或 Tenant 都不能重新赋给实体类型", () => {
    const virtualFile = path.resolve("tests/domain/__nominal-spread-case__.ts");
    const source = `
      import type { Run, TenantId } from "../../runtime-ts/packages/domain/src/index.js";
      declare const valid: Run;
      declare const otherTenant: TenantId;
      const changedStatus: Run = { ...valid, status: "succeeded" };
      const changedTenant: Run = { ...valid, tenantId: otherTenant };
      void changedStatus;
      void changedTenant;
    `;
    const options: ts.CompilerOptions = {
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      target: ts.ScriptTarget.ES2024,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
    };
    const host = ts.createCompilerHost(options);
    const originalGetSourceFile = host.getSourceFile.bind(host);
    host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) =>
      path.resolve(fileName) === virtualFile
        ? ts.createSourceFile(fileName, source, languageVersion, true, ts.ScriptKind.TS)
        : originalGetSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);

    const program = ts.createProgram({ rootNames: [virtualFile], options, host });
    const diagnostics = ts
      .getPreEmitDiagnostics(program)
      .filter((diagnostic) =>
        diagnostic.file === undefined
          ? false
          : path.resolve(diagnostic.file.fileName) === virtualFile,
      );

    expect(diagnostics).toHaveLength(2);
    expect(diagnostics.every((diagnostic) => diagnostic.code === 2322)).toBe(true);
  });
});
