#!/usr/bin/env python3
"""以隔离 LibreOffice profile 将 UTF-8 CSV/TSV 转换为经过校验的 PDF。"""

from __future__ import annotations

import argparse
import csv
import hashlib
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tempfile


MAX_INPUT_BYTES = 25 * 1024 * 1024
MAX_ROWS = 100_000
MAX_COLUMNS = 1_024
MAX_CELLS = 2_000_000
MIN_PDF_BYTES = 512
IMPORT_FILTER = "Text - txt - csv (StarCalc):44,34,76,1,,0,true,false"
ID_PATTERN = re.compile(r"\A[A-Za-z0-9][A-Za-z0-9_-]{2,127}\Z")
RESOURCE_ROOT = Path("/resources")
OUTPUT_ROOT = Path("/workspace/output")


class ConversionError(Exception):
    """可安全显示给模型的确定性转换失败。"""


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Convert a UTF-8 CSV/TSV file to PDF")
    parser.add_argument("--resource-id", required=True)
    parser.add_argument("--version-id", required=True)
    return parser.parse_args()


def locate_input(resource_id: str, version_id: str) -> Path:
    if ID_PATTERN.fullmatch(resource_id) is None or ID_PATTERN.fullmatch(version_id) is None:
        raise ConversionError("Resource ID 或 Version ID 格式无效")
    root = RESOURCE_ROOT.resolve(strict=True)
    directory = (root / resource_id / version_id).resolve(strict=True)
    try:
        directory.relative_to(root)
    except ValueError as error:
        raise ConversionError("资源目录越出 /resources") from error
    if not directory.is_dir():
        raise ConversionError("资源版本目录不存在")
    candidates: list[Path] = []
    for candidate in directory.iterdir():
        if candidate.suffix.lower() not in {".csv", ".tsv"}:
            continue
        if stat.S_ISREG(candidate.lstat().st_mode):
            candidates.append(candidate)
    if len(candidates) != 1:
        raise ConversionError("资源版本目录必须恰好包含一个普通 CSV/TSV 文件")
    return candidates[0]


def output_path(resource_id: str, version_id: str) -> Path:
    identity = hashlib.sha256(f"{resource_id}\0{version_id}".encode("ascii")).hexdigest()[:24]
    return OUTPUT_ROOT / f"csv-to-pdf-{identity}.pdf"


def normalize_table(source: Path, destination: Path) -> None:
    size = source.stat().st_size
    if size < 1 or size > MAX_INPUT_BYTES:
        raise ConversionError("输入文件为空或超过 25 MiB 限制")

    try:
        with source.open("r", encoding="utf-8-sig", errors="strict", newline="") as stream:
            sample = stream.read(min(size, 64 * 1024))
            if "\x00" in sample:
                raise ConversionError("输入包含 NUL 字符")
            stream.seek(0)
            default_delimiter = "\t" if source.suffix.lower() == ".tsv" else ","
            try:
                dialect = csv.Sniffer().sniff(sample, delimiters=",;\t|")
                delimiter = dialect.delimiter
            except csv.Error:
                delimiter = default_delimiter

            reader = csv.reader(stream, delimiter=delimiter, strict=True)
            rows = 0
            cells = 0
            with destination.open("w", encoding="utf-8", newline="") as target:
                # QUOTE_ALL 与 LibreOffice 的 quoted-as-text 选项共同阻止公式解释。
                writer = csv.writer(
                    target,
                    delimiter=",",
                    quotechar='"',
                    quoting=csv.QUOTE_ALL,
                    lineterminator="\n",
                )
                for row in reader:
                    rows += 1
                    if rows > MAX_ROWS:
                        raise ConversionError("输入超过 100000 行限制")
                    if len(row) > MAX_COLUMNS:
                        raise ConversionError("输入超过 1024 列限制")
                    cells += len(row)
                    if cells > MAX_CELLS:
                        raise ConversionError("输入超过 2000000 个单元格限制")
                    writer.writerow(row)
    except UnicodeDecodeError as error:
        raise ConversionError("输入不是有效的 UTF-8 CSV/TSV") from error
    except csv.Error as error:
        raise ConversionError("CSV/TSV 结构无效") from error

    if rows == 0 or cells == 0:
        raise ConversionError("输入没有可转换的表格单元格")


def validate_pdf(path: Path) -> None:
    if not path.is_file() or path.stat().st_size < MIN_PDF_BYTES:
        raise ConversionError("LibreOffice 未生成非空 PDF")
    with path.open("rb") as stream:
        header = stream.read(5)
        stream.seek(max(0, path.stat().st_size - 2048))
        trailer = stream.read()
    if header != b"%PDF-" or b"%%EOF" not in trailer:
        raise ConversionError("LibreOffice 输出不是完整 PDF")


def convert(resource_id: str, version_id: str) -> Path:
    source = locate_input(resource_id, version_id)
    output = output_path(resource_id, version_id)
    OUTPUT_ROOT.mkdir(parents=True, exist_ok=True)

    soffice = shutil.which("soffice")
    if soffice is None:
        raise ConversionError("Sandbox 模板缺少 LibreOffice Calc")

    with tempfile.TemporaryDirectory(prefix="csv-to-pdf-", dir=output.parent) as temporary:
        work = Path(temporary)
        normalized = work / "source.csv"
        converted = work / "source.pdf"
        profile = work / "libreoffice-profile"
        normalize_table(source, normalized)
        environment = os.environ.copy()
        environment.update(
            {
                "LANG": "C.UTF-8",
                "LC_ALL": "C.UTF-8",
                "TZ": "UTC",
                "SOURCE_DATE_EPOCH": "0",
                "SAL_USE_VCLPLUGIN": "svp",
            }
        )
        command = [
            soffice,
            "--headless",
            "--nologo",
            "--nodefault",
            "--nolockcheck",
            "--norestore",
            f"-env:UserInstallation={profile.resolve().as_uri()}",
            f"--infilter={IMPORT_FILTER}",
            "--convert-to",
            "pdf:calc_pdf_Export",
            "--outdir",
            str(work),
            str(normalized),
        ]
        try:
            result = subprocess.run(
                command,
                check=False,
                capture_output=True,
                env=environment,
                text=True,
                timeout=120,
            )
        except subprocess.TimeoutExpired as error:
            raise ConversionError("LibreOffice 转换超过 120 秒限制") from error
        if result.returncode != 0:
            raise ConversionError(f"LibreOffice 转换失败（exit={result.returncode}）")
        validate_pdf(converted)
        os.replace(converted, output)
        validate_pdf(output)
    return output


def main() -> int:
    arguments = parse_arguments()
    try:
        output = convert(arguments.resource_id, arguments.version_id)
    except (ConversionError, FileNotFoundError, OSError) as error:
        print(f"csv_to_pdf: {error}", file=sys.stderr)
        return 1
    print(str(output.resolve(strict=True)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
