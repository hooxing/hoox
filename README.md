# CubeSandbox Agent Runtime

这是多租户 Agent Runtime 的全新 TypeScript 实现仓库。旧 Python 原型仅作为行为参考，不是本仓库的运行时依赖，也不做数据兼容。

## 开发基线

- Node.js 24.18.0 LTS
- pnpm 10.15.1
- TypeScript 5.9.3
- `@earendil-works/pi-coding-agent` 0.82.1
- PostgreSQL 17（复用本机已有容器中的独立数据库）
- MinIO（由 `docker-compose.dev.yml` 独立管理）
- CubeSandbox（VMware 虚拟机部署，通过官方 Node SDK 接入）

## 当前范围

当前仓库只包含开发环境和 TypeScript Monorepo 空骨架，尚未实现 Tenant、Thread、Run、Workspace、Resource 或 Artifact 等业务功能。

## 本地启动

1. 确认根目录存在本地 `.env`。该文件包含真实凭据，已被 Git 忽略。
2. 启动开发对象存储：

   ```powershell
   docker compose -f docker-compose.dev.yml --env-file .env up -d
   ```

3. 安装依赖并执行类型检查：

   ```powershell
   corepack pnpm install
   corepack pnpm typecheck
   ```

4. 停止开发对象存储：

   ```powershell
   docker compose -f docker-compose.dev.yml --env-file .env down
   ```

不要使用 `down -v`，除非明确需要删除本仓库的 MinIO 开发数据。

## 目录边界

`runtime-ts/apps` 保存可部署进程入口，`runtime-ts/packages` 保存运行时模块，`runtime-ts/vendor` 只保存经过版本固定和许可证审查的第三方源码。CubeSandbox SDK 的固定来源见 `runtime-ts/vendor/cubesandbox-sdk/SOURCE.md`。
