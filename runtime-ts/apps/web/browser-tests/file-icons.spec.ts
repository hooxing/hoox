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

test("消息附件紧凑展示在气泡上方，图片可点击预览", async ({ page }, info) => {
  await page.goto("/browser-tests/file-preview.html");
  const request = page.locator(".user-request");
  const attachments = request.locator(":scope > .user-request-attachments");
  await expect(attachments).toBeVisible();
  await expect(request.locator(".message-card .user-request-attachments")).toHaveCount(0);
  await expect(attachments.locator(".user-request-attachment")).toHaveCount(2);
  await expect(attachments.locator(".user-request-attachment").first()).toHaveCSS("width", "280px");

  await attachments.getByRole("button", { name: "预览图片 示例图片.png" }).click();
  await expect(page.getByRole("dialog", { name: "图片预览：示例图片.png" })).toBeVisible();
  await page.screenshot({ path: info.outputPath("message-image-preview.png") });
  await page.getByRole("button", { name: "关闭图片预览" }).click();
  await expect(page.getByRole("dialog", { name: "图片预览：示例图片.png" })).toHaveCount(0);
});
