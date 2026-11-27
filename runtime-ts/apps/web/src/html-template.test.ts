import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it.each(["index.html", "workspace.html"])("%s 保留 Hoox 开源署名", (template) => {
  const html = readFileSync(new URL(`../${template}`, import.meta.url), "utf8");
  expect(html).toMatch(/<meta\s+name="generator"\s+content="Hoox"\s*\/?>/u);
  expect(html).toMatch(/<!--[^<>]*https:\/\/github\.com\/hooxing\/hoox[^<>]*-->/u);
});
