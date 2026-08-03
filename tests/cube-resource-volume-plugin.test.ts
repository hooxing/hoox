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

  it("rclone 后台进程不继承 Cubelet 的 Hook 输出管道", () => {
    expect(script).not.toContain("--daemon");
    expect(script).toMatch(/--file-perms 0444 \\\r?\n\s*<\/dev\/null >\/dev\/null 2>&1 &/u);
    expect(script).toContain('mount_pid="$!"');
    expect(script).toContain('kill -0 "$mount_pid"');
    expect(script).toContain('pid_file="$' + '{log_root}/rclone.pid"');
    expect(script).toContain("mapfile -d '' -t tracked_args");
    expect(script).toContain('"$' + '{tracked_args[3]-}" == "$volume_root"');
    expect(script).toContain('kill -KILL "$tracked_pid"');
    expect(script).toMatch(
      /if ! mountpoint -q "\$volume_root"; then\s*#.*\s*stop_tracked_rclone \|\| fail/u,
    );
  });

  it("Attach 在返回 host_path 前验证远端与 FUSE 数据面，并只修复无既有使用者的坏挂载", () => {
    expect(script).toContain('"$RESOURCEFS_RCLONE_BIN" lsf resourcefs:');
    expect(script).toContain("--contimeout 5s");
    expect(script).toContain("--timeout 10s");
    expect(script).toContain("--retries 1");
    expect(script).toContain("--low-level-retries 1");
    expect(script).toContain('timeout --signal=KILL 10s ls -A -- "$volume_root"');
    expect(script).toMatch(
      /probe_resourcefs_remote \|\| fail[\s\S]*\[\[ "\$REF_COUNT" == "1" \]\] \|\| fail[\s\S]*unmount_resourcefs \|\| fail/u,
    );
    expect(script).toMatch(
      /if ! probe_resourcefs_mount; then[\s\S]*unmount_resourcefs \|\| true[\s\S]*kill "\$mount_pid"/u,
    );
    expect(script.indexOf("probe_resourcefs_remote || fail")).toBeLessThan(
      script.indexOf(`printf '{"host_path":"%s"`),
    );
  });

  it("Detach 从 root 配置重建固定路径而不依赖未提供的 volume-base-dir", () => {
    expect(script).toContain(`: "\${RESOURCEFS_VOLUME_BASE_DIR:=/data/cube-shared/volume}"`);
    expect(script).toContain(`: "\${RESOURCEFS_RCLONE_BIN:=/usr/bin/rclone}"`);
    expect(script.indexOf(`: "\${RESOURCEFS_RCLONE_BIN:=/usr/bin/rclone}"`)).toBeLessThan(
      script.indexOf('case "$OP" in'),
    );
    expect(script).toContain('expected_metadata="$(printf');
    expect(script).toContain('[[ "$METADATA" == "$expected_metadata" ]]');
    expect(script).not.toMatch(/detach\)\s*\n\s*\[\[ "\$VOLUME_BASE_DIR"/u);
    expect(script).not.toContain('mountpoint -q "$volume_root" && fail');
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
