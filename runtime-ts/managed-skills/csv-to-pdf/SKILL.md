---
name: csv-to-pdf
description: 将 UTF-8 CSV 或 TSV 表格转换为经过校验的 PDF，并作为任务文件交付。
license: LicenseRef-AISay-Internal
---

# CSV / TSV 转 PDF

当用户要求把 `.csv` 或 `.tsv` 表格转换为 PDF 时使用本技能。不要把扩展名已经是 `.pdf` 的文件再次转换。

## 执行步骤

1. 从当前用户消息的稳定附件路径 `/resources/<resourceId>/<versionId>/<文件名>` 确认唯一输入附件；存在多个候选时先向用户确认，不要猜测。
2. 只提取 `resourceId` 与 `versionId`。两者都必须完全匹配
   `^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$`；不匹配时停止，绝不能把文件名或完整路径传给命令。
3. 读取运行时 Skill 指令中的 `package_root`，脚本位于
   `<package_root>/scripts/csv_to_pdf.py`。`package_root` 是运行时提供的受信固定值，不要复制或改写脚本。
4. 只把校验后的两个 ID 传给脚本：

   ```bash
   python3 "<package_root>/scripts/csv_to_pdf.py" --resource-id "<resourceId>" --version-id "<versionId>"
   ```

5. 脚本会在 stdout 返回固定、安全的 `/workspace/output/csv-to-pdf-<摘要>.pdf`。只有脚本以 0
   退出后，才用这个返回路径调用 `deliver_file`，并省略可选 `name` 参数。脚本失败时不得交付旧文件或伪造成功。

## 固定边界

- 输入只接受 UTF-8（可带 BOM）的 CSV/TSV；不猜测旧编码。
- wrapper 自行进入 `/resources/<resourceId>/<versionId>/`，并要求其中恰好一个非符号链接的普通
  `.csv`/`.tsv` 文件。用户文件名永远不会进入 shell 命令或输出名。
- 脚本会把全部单元格作为文本导入，避免 CSV 中以 `=`、`+`、`-` 或 `@` 开头的内容被当作公式执行。
- 单文件上限 25 MiB、100000 行、1024 列且总计不超过 2000000 个单元格；超限时说明限制并停止。
- 输出路径由 wrapper 根据两个 ID 的 SHA-256 固定派生。不要直接运行裸 `soffice`，也不要在 Run 内安装系统依赖。
