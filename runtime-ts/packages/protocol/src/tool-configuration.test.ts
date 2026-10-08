import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import {
  RuntimeSettingsConfigurationDtoSchema,
  SaveRuntimeSettingsConfigurationRequestSchema,
} from "./admin-control.js";
import { normalizeRuntimeToolSelection, RUNTIME_TOOL_NAMES } from "./tool-configuration.js";

const configuration = {
  workerMaxConcurrentRuns: 20,
  userMaxConcurrentRunsPerTenant: 2,
  compactionSoftLimitPercent: 80,
  compactionTargetPercent: 55,
  compactionRecentUserTokens: 4096,
  compactionMaxOutputTokens: 4096,
  compactionTimeoutMs: 60000,
};

describe("平台工具选择契约", () => {
  it.each([undefined, [], ["read"], [...RUNTIME_TOOL_NAMES]])(
    "保留旧配置、空清单与已知选择 %j",
    (enabledTools) => {
      const input = { ...configuration, ...(enabledTools === undefined ? {} : { enabledTools }) };
      expect(Value.Check(RuntimeSettingsConfigurationDtoSchema, input)).toBe(true);
      expect(
        Value.Check(SaveRuntimeSettingsConfigurationRequestSchema, {
          ...input,
          expectedGeneration: 0,
        }),
      ).toBe(true);
      expect(normalizeRuntimeToolSelection(enabledTools)).toEqual(enabledTools);
    },
  );
  it.each([
    null,
    false,
    "read",
    ["unknown"],
    ["run_code"],
    ["collapse_process_for_final_answer"],
    ["read", "read"],
    [1],
    [null],
    [...RUNTIME_TOOL_NAMES, "read"],
  ])("拒绝无效选择 %j", (enabledTools) => {
    const input = { ...configuration, enabledTools };
    expect(Value.Check(RuntimeSettingsConfigurationDtoSchema, input)).toBe(false);
    expect(
      Value.Check(SaveRuntimeSettingsConfigurationRequestSchema, {
        ...input,
        expectedGeneration: 0,
      }),
    ).toBe(false);
    expect(() => normalizeRuntimeToolSelection(enabledTools)).toThrow("启用工具");
  });
  it("排序稳定、复制冻结且不改调用方输入", () => {
    const input = ["skill", "write", "read"];
    const normalized = normalizeRuntimeToolSelection(input);
    expect(normalized).toEqual(["read", "write", "skill"]);
    expect(normalized).toEqual(normalizeRuntimeToolSelection([...input].reverse()));
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(input).toEqual(["skill", "write", "read"]);
    input.push("exec_command");
    expect(normalized).not.toContain("exec_command");
    expect(() => normalizeRuntimeToolSelection(new Array(1))).toThrow("启用工具");
  });
});
