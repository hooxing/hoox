import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const script = readFileSync(
  resolve("deploy/cube-resource-volume/resourcefs-volume-plugin.sh"),
  "utf8",
);

describe("Cube ResourceFS binary Volume plugin 契约", () => {
  it("实现 Cube 0.6 四个 hook，并只在宿主机建立只读挂载", () => {
    expect(script).toContain("create)");
    expect(script).toContain("destroy)");
    expect(script).toContain("attach)");
    expect(script).toContain("detach)");
    expect(script).toContain('"$RESOURCEFS_RCLONE_BIN" mount resourcefs: "$volume_root"');
    expect(script).toContain("--read-only");
    expect(script).toContain("--dir-perms 0555");
    expect(script).toContain("--file-perms 0444");
    expect(script).not.toContain("S3_ACCESS_KEY");
    expect(script).not.toContain("MINIO_");
  });

  it("宿主 capability 与 Runtime v2 JSON/HMAC 输入保持字节一致", () => {
    expect(script).toContain('printf \'{"v":2,"tenantId":"%s"}\' "$VOLUME_ID"');
    expect(script).toContain(
      'openssl dgst -sha256 -hmac "$RESOURCE_FILESYSTEM_SIGNING_KEY" -binary',
    );
    expect(script).toContain('RCLONE_CONFIG_RESOURCEFS_BEARER_TOKEN="$capability"');
  });

  it("Destroy 只删除 Cube 视图事实，不执行对象或目录递归删除", () => {
    expect(script).not.toMatch(/\brm\s+-rf\b/u);
    expect(script).not.toContain("aws s3 rm");
    expect(script).not.toContain("rclone delete");
  });
});
