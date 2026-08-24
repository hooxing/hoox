/**
 * Better Auth 暴露多个框架、ORM 与测试适配器的 optional peer；Hoox 服务端只使用 pg。
 * 若让 pnpm 从 workspace 根解析其余 peer，生产 deploy 会误带 React/Vitest/Vite 等开发闭包。
 */
function keepOnlyPeerDependencies(pkg, allowedPeers) {
  if (pkg.peerDependencies === undefined) return pkg;
  for (const peerName of Object.keys(pkg.peerDependencies)) {
    if (allowedPeers.has(peerName)) continue;
    delete pkg.peerDependencies[peerName];
    if (pkg.peerDependenciesMeta !== undefined) delete pkg.peerDependenciesMeta[peerName];
  }
  return pkg;
}

module.exports = {
  hooks: {
    readPackage(pkg) {
      if (pkg.name === "better-auth" && pkg.version === "1.7.1") {
        return keepOnlyPeerDependencies(pkg, new Set(["pg"]));
      }
      if (pkg.name === "@better-auth/core" && pkg.version === "1.7.1") {
        return keepOnlyPeerDependencies(
          pkg,
          new Set([
            "@better-auth/utils",
            "@better-fetch/fetch",
            "better-call",
            "jose",
            "kysely",
            "nanostores",
          ]),
        );
      }
      return pkg;
    },
  },
};
