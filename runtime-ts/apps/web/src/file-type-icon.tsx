import {
  FileArchive,
  FileAudio,
  FileCode,
  FileCog,
  FileImage,
  FileQuestion,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Presentation,
  type LucideIcon,
} from "lucide-react";

const icons = {
  gif: FileImage,
  config: FileCog,
  blank: FileQuestion,
  docx: FileText,
  xlsx: FileSpreadsheet,
  pptx: Presentation,
  pdf: FileText,
  csv: FileSpreadsheet,
  txt: FileText,
  md: FileText,
  json: FileCode,
  html: FileCode,
  xml: FileCode,
  js: FileCode,
  py: FileCode,
  zip: FileArchive,
  image: FileImage,
  mp3: FileAudio,
  mp4: FileVideo,
  svg: FileImage,
} satisfies Readonly<Record<string, LucideIcon>>;

const extensionIcons: Readonly<Record<string, keyof typeof icons>> = {
  doc: "docx",
  docx: "docx",
  docm: "docx",
  dot: "docx",
  dotx: "docx",
  odt: "docx",
  rtf: "docx",
  xls: "xlsx",
  xlsx: "xlsx",
  xlsm: "xlsx",
  xlsb: "xlsx",
  xltx: "xlsx",
  ods: "xlsx",
  ppt: "pptx",
  pptx: "pptx",
  pptm: "pptx",
  pps: "pptx",
  ppsx: "pptx",
  odp: "pptx",
  pdf: "pdf",
  csv: "csv",
  tsv: "csv",
  txt: "txt",
  log: "txt",
  md: "md",
  markdown: "md",
  json: "json",
  yaml: "config",
  yml: "config",
  html: "html",
  htm: "html",
  xml: "xml",
  js: "js",
  jsx: "js",
  ts: "js",
  tsx: "js",
  py: "py",
  zip: "zip",
  rar: "zip",
  "7z": "zip",
  tar: "zip",
  gz: "zip",
  tgz: "zip",
  bz2: "zip",
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "gif",
  webp: "image",
  avif: "image",
  heic: "image",
  bmp: "image",
  tiff: "image",
  svg: "svg",
  mp3: "mp3",
  wav: "mp3",
  ogg: "mp3",
  m4a: "mp3",
  flac: "mp3",
  mp4: "mp4",
  mov: "mp4",
  webm: "mp4",
  avi: "mp4",
  mkv: "mp4",
};

const mediaTypeIcons: Readonly<Record<string, keyof typeof icons>> = {
  "application/msword": "docx",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-excel": "xlsx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-powerpoint": "pptx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/pdf": "pdf",
  "text/csv": "csv",
  "text/plain": "txt",
  "text/markdown": "md",
  "application/json": "json",
  "text/html": "html",
  "application/xml": "xml",
  "text/xml": "xml",
  "image/svg+xml": "svg",
  "application/zip": "zip",
  "application/x-zip-compressed": "zip",
  "application/x-7z-compressed": "zip",
};

export function fileIconKind(name: string, mediaType?: string): keyof typeof icons {
  const filename = name.split(/[\\/]/u).at(-1) ?? name;
  const extension = filename.includes(".") ? filename.split(".").at(-1)?.toLowerCase() : undefined;
  // 图标只用于展示；扩展名优先，缺失或未知时用 MIME 兜底，不参与预览或执行权限判断。
  const byExtension =
    extension !== undefined && Object.hasOwn(extensionIcons, extension)
      ? extensionIcons[extension]
      : undefined;
  if (byExtension !== undefined) return byExtension;
  const normalized = mediaType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  const byMediaType = Object.hasOwn(mediaTypeIcons, normalized)
    ? mediaTypeIcons[normalized]
    : undefined;
  if (byMediaType !== undefined) return byMediaType;
  if (normalized.startsWith("image/")) return "image";
  if (normalized.startsWith("audio/")) return "mp3";
  if (normalized.startsWith("video/")) return "mp4";
  if (normalized.startsWith("text/")) return "txt";
  return "blank";
}

export function FileTypeIcon({
  name,
  mediaType,
  size = 32,
}: {
  readonly name: string;
  readonly mediaType?: string | undefined;
  readonly size?: 24 | 32 | 48;
}) {
  const kind = fileIconKind(name, mediaType);
  const Icon = icons[kind];
  return (
    <span
      className="file-type-icon"
      data-file-icon={kind}
      aria-hidden="true"
      style={{ display: "inline-flex", flexShrink: 0, width: size, height: size }}
    >
      <Icon size={size} strokeWidth={1.75} />
    </span>
  );
}
