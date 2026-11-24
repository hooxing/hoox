import { chmod, readFile, writeFile } from "node:fs/promises";
import { build } from "esbuild";

await build({
  entryPoints: ["src/bin.ts"],
  outfile: "dist/hoox.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  sourcemap: true,
  banner: {
    js: 'import { createRequire as createBundleRequire } from "node:module"; const require = createBundleRequire(import.meta.url);',
  },
});
await chmod("dist/hoox.js", 0o755);
const licenses = await Promise.all(
  [
    ["@sinclair/typebox", "../../protocol/node_modules/@sinclair/typebox/license"],
    ["yaml", "../../protocol/node_modules/yaml/LICENSE"],
  ].map(
    async ([name, path]) => `${name}\n\n${await readFile(new URL(path, import.meta.url), "utf8")}`,
  ),
);
await writeFile("dist/THIRD_PARTY_LICENSES", licenses.join("\n\n---\n\n"));
await writeFile(
  "dist/LICENSE",
  await readFile(new URL("../../../../LICENSE", import.meta.url), "utf8"),
);
const manifest = JSON.parse(await readFile("package.json", "utf8"));
await writeFile(
  "dist/package.json",
  `${JSON.stringify(
    {
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      license: manifest.license,
      type: "module",
      engines: manifest.engines,
      bin: { hoox: "hoox.js" },
      files: ["hoox.js", "hoox.js.map", "LICENSE", "THIRD_PARTY_LICENSES"],
    },
    null,
    2,
  )}\n`,
);
