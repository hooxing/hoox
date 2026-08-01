# 以现有 Agent Sandbox 镜像为基础，避免本叠加层替换其编译器、Office 或媒体工具。
ARG BASE_IMAGE
ARG RCLONE_IMAGE
FROM ${RCLONE_IMAGE} AS rclone
FROM ${BASE_IMAGE}

USER root
COPY --from=rclone /usr/local/bin/rclone /usr/local/bin/rclone
RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates fuse3 \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /resources /workspace /tmp/resource-fs-cache /tmp/resource-fs-log \
    && chmod 0755 /resources /workspace \
    && chmod 0700 /tmp/resource-fs-cache /tmp/resource-fs-log

# CubeSandbox 运行配置仍须提供 /dev/fuse；模板内安装客户端并不能替代设备授权。
