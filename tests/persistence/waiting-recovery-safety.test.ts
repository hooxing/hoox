import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const root = new URL("../../", import.meta.url);
const source = () =>
  readFile(new URL("runtime-ts/packages/persistence/src/pg-waiting-recovery.ts", root), "utf8");
const migration = (direction: "up" | "down") =>
  readFile(
    new URL(
      `runtime-ts/packages/persistence/migrations/0012_waiting_recovery.${direction}.sql`,
      root,
    ),
    "utf8",
  );

describe("waiting recovery 安全回归契约", () => {
  it("Runtime role 只在列级白名单内获得 outbox payload 更新权", async () => {
    const role = await readFile(
      new URL("runtime-ts/packages/persistence/src/role-bootstrap.ts", root),
      "utf8",
    );
    expect(role).toContain(
      '["waiting_recovery_effect_outbox", new Set(["state", "payload", "updated_at"])]',
    );
    expect(role).toContain("GRANT UPDATE(state,payload,updated_at)");
  });

  it("record 与 claim 绑定最新 Attempt、waiting event、Rollout tail，并从 pause 事实推导候选", async () => {
    const text = await source();
    expect(text).toContain("ORDER BY latest.created_at DESC,latest.attempt_id DESC LIMIT 1");
    expect(text).toContain("event.sequence=(SELECT max(tail.sequence)");
    expect(text).toContain("rollout_checkpoint.through_sequence=rollout_tail.sequence");
    expect(text).toContain("cleanup.state='completed'");
    expect(text).toContain("cleanup.disposition='pause'");
    expect(text).not.toContain("const sandbox = input.sandbox");
  });

  it("effect 由一次性 capability 与持久 plan 双重绑定，resolve 不接受替换事实", async () => {
    const text = await source();
    expect(text).toContain("capabilityDigest");
    expect(text).toContain("payload->>'capabilityDigest'=$5 FOR UPDATE");
    expect(text).toContain("digestCanonical(payload.plan) !== digestCanonical(decision)");
    expect(text).not.toContain("readonly sandboxFact?: object");
  });

  it("completed connect 在 registry 状态检查前识别，complete 再以数据库时钟复查 TTL", async () => {
    const text = await source();
    expect(text.indexOf('priorRow?.state === "completed"')).toBeLessThan(
      text.indexOf('if (input.effect === "connect")'),
    );
    expect(text).toContain("$1::timestamptz>clock_timestamp() AS valid");
    expect(text).toContain('await this.persistUnknown(client, row, "connect")');
  });

  it("恢复 Rollout 复用 canonical digest 与普通 append 的 advisory lock 协议", async () => {
    const text = await source();
    expect(text).toContain("const digest = digestCanonical(eventFact)");
    expect(text).toContain("pg_advisory_xact_lock(hashtextextended($1, 0))");
    expect(text).toMatch(/\.join\(\s*"\\u001f",?\s*\)/u);
  });

  it("0012 down 不删除只追加恢复事实，存在事实时明确拒绝并由事务回滚", async () => {
    const down = await migration("down");
    expect(down).toContain("0012 down refused: waiting recovery append-only facts exist");
    expect(down).not.toMatch(/DELETE FROM (run_events|runtime_rollout_entries)/u);
  });

  it("intent ID 固定长度且 resolved 幂等分支可从 Scope 行到达", async () => {
    const text = await source();
    expect(text).toContain('.digest("hex").slice(0, 32)');
    expect(text).toContain('existing?.state === "resolved"');
    expect(text).toContain('"already_resolved" as const');
  });
});
