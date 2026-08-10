import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("团队任务可见性", () => {
  it("创建者离开后，仍由当前有效成员读取任务", async () => {
    const source = await readFile(new URL("./pg-core-repositories.ts", import.meta.url), "utf8");
    expect(source).toContain("auth.user_id = $2 AND auth.status = 'active'");
    expect(source).not.toContain(
      "thread_creator_membership.user_id = th.created_by_user_id\n   AND thread_creator_membership.status = 'active'",
    );
  });
});
