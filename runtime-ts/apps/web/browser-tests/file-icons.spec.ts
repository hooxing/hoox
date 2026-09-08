import { expect, test } from "@playwright/test";

test("交付文件在大小屏显示可加载的彩色图标，上传文件复用类型图标", async ({ page }, info) => {
  await page.goto("/browser-tests/file-preview.html");
  const delivery = page.locator(".inline-artifact-list");
  await expect(delivery.locator('[data-file-icon="docx"]')).toBeVisible();
  await expect(delivery.locator('[data-file-icon="xlsx"]')).toBeVisible();
  await expect(delivery.locator('[data-file-icon="pptx"]')).toBeVisible();
  await expect(delivery.locator('[data-file-icon="pdf"]')).toBeVisible();
  for (const icon of await delivery.locator(".file-type-icon").all()) {
    expect(
      await icon.evaluate(async (element) => {
        const src = getComputedStyle(element).backgroundImage.slice(5, -2);
        const image = new Image();
        image.src = src;
        await image.decode();
        return image.naturalWidth > 0;
      }),
    ).toBe(true);
  }
  await page
    .locator('input[type="file"]')
    .first()
    .setInputFiles({
      name: "公告模板.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      buffer: Buffer.from("fixture"),
    });
  await expect(page.locator('.composer-file [data-file-icon="docx"]')).toBeVisible();
  await page.screenshot({ path: info.outputPath("file-icons-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".sidebar")).toHaveAttribute("aria-hidden", "true");
  await page.screenshot({ animations: "disabled" });
  await expect(delivery.locator('[data-file-icon="docx"]')).toBeVisible();
  await expect(page.getByRole("button", { name: "下载 sample.docx", exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath("file-icons-mobile.png"), fullPage: true });
});
