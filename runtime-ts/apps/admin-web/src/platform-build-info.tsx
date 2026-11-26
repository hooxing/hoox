import { InfoCircleOutlined } from "@ant-design/icons";
import { Popover } from "antd";
import { useState } from "react";

declare const __HOOX_BUILD_INFO__: {
  readonly version: string;
  readonly sha: string;
  readonly builtAt?: string;
};

export function PlatformBuildInfo({
  collapsed,
  releaseId,
}: {
  readonly collapsed: boolean;
  readonly releaseId: string | undefined;
}) {
  const [open, setOpen] = useState(false);
  const build = typeof __HOOX_BUILD_INFO__ === "undefined" ? undefined : __HOOX_BUILD_INFO__;
  const version = build === undefined || build.version === "dev" ? "dev" : `v${build.version}`;
  const sha = build?.sha ?? "unknown";
  const summary = `${version} · ${sha.slice(0, 7)}`;
  return (
    <Popover
      title="构建信息"
      trigger="click"
      placement="topLeft"
      open={open}
      onOpenChange={setOpen}
      destroyOnHidden
      content={
        <dl className="platform-build-details">
          <dt>版本</dt>
          <dd>{version}</dd>
          <dt>提交 SHA</dt>
          <dd>
            <code>{sha}</code>
          </dd>
          <dt>构建时间（UTC）</dt>
          <dd>
            {build?.builtAt === undefined ? (
              "未知"
            ) : (
              <time dateTime={build.builtAt}>{build.builtAt}</time>
            )}
          </dd>
          {releaseId !== undefined && (
            <>
              <dt>Demo 发布 ID</dt>
              <dd>
                <code>{releaseId}</code>
              </dd>
            </>
          )}
        </dl>
      }
    >
      <button
        type="button"
        className="platform-build-trigger"
        aria-label={`构建信息：${summary}`}
        aria-expanded={open}
        onKeyDown={(event) => {
          if (event.key === "Escape" && open) setOpen(false);
        }}
      >
        <InfoCircleOutlined aria-hidden="true" />
        {!collapsed && (
          <span className="platform-build-summary">
            <span>{summary}</span>
            {releaseId !== undefined && <small>Demo：{releaseId}</small>}
          </span>
        )}
      </button>
    </Popover>
  );
}
