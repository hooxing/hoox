import { describe, expect, it } from "vitest";
import { recoverLatestRunForNavigation, WorkspaceNavigation } from "./navigation.js";

describe("WorkspaceNavigation", () => {
  it("切换 Thread 后拒绝旧 Thread 的迟到命令响应", () => {
    const navigation = new WorkspaceNavigation();
    navigation.navigate("thread_1");
    const pendingCommand = navigation.capture();

    navigation.navigate("thread_2");

    expect(navigation.isCurrent(pendingCommand)).toBe(false);
    expect(navigation.isSelected("thread_2")).toBe(true);
  });

  it("切走后再选回同一 Thread 也不会恢复旧命令代次", () => {
    const navigation = new WorkspaceNavigation();
    navigation.navigate("thread_1");
    const pendingCommand = navigation.capture();

    navigation.navigate("thread_2");
    navigation.navigate("thread_1");

    expect(navigation.isCurrent(pendingCommand)).toBe(false);
    expect(navigation.isSelected("thread_1")).toBe(true);
  });

  it("恢复响应在导航代次变化后被丢弃", async () => {
    const navigation = new WorkspaceNavigation();
    const expected = navigation.navigate("thread_1");
    let resolve!: (value: string) => void;
    const pending = recoverLatestRunForNavigation(
      navigation,
      expected,
      () =>
        new Promise<string>((done) => {
          resolve = done;
        }),
    );
    navigation.navigate("thread_2");
    resolve("run_1");
    await expect(pending).resolves.toBeUndefined();
  });
});
