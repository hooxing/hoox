import { expect, test } from "@playwright/test";

test("DOCX 原生文字选择就近引用，取消选择隐藏浮层，引用进入输入框", async ({ page }, info) => {
  await page.goto("/browser-tests/file-preview.html");
  await page.getByRole("button", { name: "预览 sample.docx", exact: true }).click();
  const pane = page.locator(".file-preview-panel");
  await expect(pane.getByText("选中文字，即可引用到对话")).toBeVisible();
  await expect(pane.getByRole("button", { name: "框选区域", exact: true })).toHaveCount(0);
  const frame = page.frameLocator("iframe");
  const paragraph = frame.getByText("这是第一段内容。用户可以选择这段文字，要求 Agent 修改。", {
    exact: true,
  });
  const bounds = await paragraph.boundingBox();
  if (!bounds) throw new Error("正文不可见");
  await page.mouse.move(bounds.x + 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  // 直接发送原生鼠标移动，避免测试驱动把文字选择交给拖放探测。
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: bounds.x + bounds.width * 0.65,
    y: bounds.y + bounds.height / 2,
    button: "left",
    buttons: 1,
  });
  await expect
    .poll(() => paragraph.evaluate((element) => element.ownerDocument.getSelection()?.toString()))
    .toContain("这是");
  await page.mouse.up();
  await cdp.detach();
  const popup = pane.getByRole("toolbar", { name: "选区操作" });
  await expect(popup).toBeVisible();
  const popupBounds = await popup.boundingBox();
  expect(popupBounds?.y).toBeLessThan(bounds.y);
  await page.screenshot({ path: info.outputPath("desktop-selection.png") });
  await pane.getByRole("button", { name: "引用到对话" }).click();
  await expect(page.locator(".composer").getByRole("list", { name: "待发送引用" })).toContainText(
    "sample.docx",
  );
  await expect(popup).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("desktop-reference.png") });
  await paragraph.evaluate((element) => {
    const range = element.ownerDocument.createRange();
    range.selectNodeContents(element);
    const selection = element.ownerDocument.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  await expect(popup).toBeVisible();
  await pane.getByRole("combobox", { name: "预览缩放" }).selectOption("150");
  await frame
    .locator("body")
    .evaluate((element) => element.ownerDocument.defaultView?.scrollTo(0, 1000));
  await expect(popup).toHaveCount(0);
  await frame
    .locator("body")
    .evaluate((element) => element.ownerDocument.defaultView?.scrollTo(0, 0));
  await expect(popup).toBeVisible();
  await frame.locator("#page").click({ position: { x: 4, y: 4 } });
  await expect(popup).toHaveCount(0);
});

test("小屏文字引用浮层保持在视口内，缩放后重新定位", async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/browser-tests/file-preview.html");
  await page.getByRole("button", { name: "预览 sample.pdf", exact: true }).click();
  const pane = page.locator(".file-preview-panel");
  await expect(pane.getByText("选中文字，即可引用到对话")).toBeVisible();
  await pane.getByRole("button", { name: "查找文字", exact: true }).click();
  await pane.getByRole("textbox", { name: "查找当前页文字" }).fill("Select this sentence");
  await pane.getByRole("button", { name: "查找", exact: true }).click();
  await pane.getByRole("button", { name: "关闭查找" }).click();
  const popup = pane.getByRole("toolbar", { name: "选区操作" });
  await expect(popup).toBeVisible();
  const rect = await popup.boundingBox();
  expect(rect?.x).toBeGreaterThanOrEqual(0);
  expect((rect?.x ?? 0) + (rect?.width ?? 0)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: info.outputPath("mobile-selection.png") });
  await pane.getByRole("combobox", { name: "预览缩放" }).selectOption("75");
  await expect(popup).toBeVisible();
  await pane.getByRole("button", { name: "引用到对话" }).click();
  await expect(pane.locator(".file-preview-mobile-reply summary")).toContainText("1 处引用");
});

for (const extension of ["docx", "pptx", "pdf", "png", "txt", "md", "xlsx", "csv"]) {
  test(`${extension} 在浏览器中预览、选择、发送并返回原版本`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("/browser-tests/file-preview.html");
    await page.getByRole("button", { name: `预览 sample.${extension}`, exact: true }).click();
    const pane = page.locator(".file-preview-panel");
    if (extension === "xlsx" || extension === "csv") {
      await expect(pane.getByRole("button", { name: "A1", exact: true })).toBeVisible();
      await pane.getByRole("textbox", { name: "单元格范围" }).fill("A1:B2");
      await pane.getByRole("button", { name: "选择范围", exact: true }).click();
      if (extension === "xlsx") await expect(pane.getByText("合并区域说明")).toBeVisible();
    } else {
      await expect(pane.locator(".preview-selection-hint")).toBeVisible();
      if (extension !== "png") await pane.getByRole("button", { name: "更多预览操作" }).click();
      await pane.getByRole("button", { name: "框选区域", exact: true }).click();
      const frame = page.frames().find((candidate) => candidate.url() === "about:srcdoc");
      if (!frame) throw new Error("预览 iframe 未创建");
      const content = frame.locator(extension === "docx" ? "section.docx:visible" : "#page");
      const box = await content.boundingBox();
      if (!box) throw new Error("预览页面不可见");
      if (extension === "pdf") {
        expect(box.height).toBeGreaterThan(500);
        await expect(content.locator(".textLayer span").first()).toContainText("Preview document");
      }
      await page.mouse.move(box.x + box.width * 0.12, box.y + Math.min(box.height * 0.15, 60));
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * 0.6, box.y + Math.min(box.height * 0.55, 240), {
        steps: 6,
      });
      await page.mouse.up();
      await expect(frame.locator("#selection-box")).toBeVisible();
    }
    await pane.getByRole("button", { name: "引用到对话", exact: true }).click();
    await expect(page.getByRole("list", { name: "待发送引用" })).toContainText(
      `sample.${extension}`,
    );
    await pane.getByRole("button", { name: "关闭文件预览" }).click();
    await page.getByRole("textbox", { name: "发送给 Hoox 的任务" }).fill("请修改选中内容");
    await page.getByRole("button", { name: "发送任务", exact: true }).click();
    const cards = page.getByRole("list", { name: "引用的文件区域" });
    await expect(cards).toContainText(`sample.${extension}`);
    await cards.getByRole("button").click();
    await expect(page.locator(".preview-file-title small")).toHaveAttribute(
      "title",
      `引用版本 version_${extension}`,
    );
    if (extension !== "xlsx" && extension !== "csv")
      await expect(page.frameLocator("iframe").locator("#selection-box")).toBeVisible();
    expect(errors).toEqual([]);
  });
}

test("PDF 文字选择保持文本层位置，关闭与刷新后引用草稿仍可发送", async ({ page }) => {
  await page.goto("/browser-tests/file-preview.html");
  await page.getByRole("button", { name: "预览 sample.pdf", exact: true }).click();
  const pane = page.locator(".file-preview-panel");
  await expect(pane.locator(".preview-selection-hint")).toBeVisible();
  await pane.getByRole("button", { name: "查找文字", exact: true }).click();
  await pane.getByRole("textbox", { name: "查找当前页文字" }).fill("Select this sentence");
  await pane.getByRole("button", { name: "查找", exact: true }).click();
  const selected = await page
    .frameLocator("iframe")
    .locator(".textLayer")
    .evaluate((element) => element.ownerDocument.getSelection()?.toString());
  expect(selected).toBe("Select this sentence");
  await pane.getByRole("button", { name: "引用到对话", exact: true }).click();
  await pane.getByRole("button", { name: "关闭文件预览" }).click();
  await page.reload();
  await expect(page.getByRole("list", { name: "待发送引用" })).toContainText(
    "Select this sentence",
  );
});

test("小屏全屏阅读、触摸框选、调整范围并在底部提交修改", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/browser-tests/file-preview.html");
  await page.getByRole("button", { name: "预览 sample.png", exact: true }).click();
  const pane = page.locator(".file-preview-panel");
  await expect(pane.locator(".preview-selection-hint")).toBeVisible();
  expect((await pane.boundingBox())?.width).toBe(390);
  await pane.getByRole("button", { name: "框选区域", exact: true }).click();
  const frame = page.frameLocator("iframe");
  const rect = await frame.locator("#page").boundingBox();
  if (!rect) throw new Error("图片尚未显示");
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: rect.x + rect.width * 0.1, y: rect.y + rect.height * 0.1 }],
  });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [{ x: rect.x + rect.width * 0.7, y: rect.y + rect.height * 0.7 }],
  });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
  await expect(pane.getByRole("button", { name: "引用到对话", exact: true })).toBeEnabled();
  await expect(frame.locator("#selection-box [data-corner]")).toHaveCount(4);
  await pane.getByRole("button", { name: "引用到对话", exact: true }).click();
  await page.locator(".file-preview-mobile-reply summary").click();
  await page.getByRole("textbox", { name: "预览中的修改要求" }).fill("把选中部分改为绿色");
  await page.getByRole("button", { name: "发送修改要求", exact: true }).click();
  await expect(page.locator(".file-preview-mobile-reply summary")).toContainText("0 处引用");
});
