import { Type, type Static } from "@sinclair/typebox";

export const MAX_BRAND_LOGO_BYTES = 48 * 1024;
export const BRAND_MODULES = [
  "team_spaces",
  "artifacts",
  "history_files",
  "skills",
  "automations",
] as const;
const strict = { additionalProperties: false } as const;
export const BrandConfigurationSchema = Type.Object(
  {
    productName: Type.String({ minLength: 1, maxLength: 60 }),
    logoDataUrl: Type.Union([Type.Null(), Type.String({ maxLength: 65580 })]),
    primaryColor: Type.Union([Type.Null(), Type.String({ pattern: "^#[0-9a-fA-F]{6}$" })]),
    footerLinks: Type.Array(
      Type.Object(
        {
          text: Type.String({ minLength: 1, maxLength: 60 }),
          url: Type.String({ minLength: 1, maxLength: 2048 }),
        },
        strict,
      ),
      { maxItems: 5 },
    ),
    hiddenModules: Type.Array(Type.Union(BRAND_MODULES.map((module) => Type.Literal(module))), {
      uniqueItems: true,
      maxItems: BRAND_MODULES.length,
    }),
  },
  strict,
);
export type BrandConfiguration = Static<typeof BrandConfigurationSchema>;
export type BrandModule = BrandConfiguration["hiddenModules"][number];
export const DEFAULT_BRANDING: BrandConfiguration = Object.freeze({
  productName: "Hoox",
  logoDataUrl: null,
  primaryColor: null,
  footerLinks: Object.freeze([]) as unknown as [],
  hiddenModules: Object.freeze([]) as unknown as [],
});
export const SaveBrandingRequestSchema = Type.Object(
  {
    expectedGeneration: Type.Integer({ minimum: 0, maximum: 2147483646 }),
    requestId: Type.String({ pattern: "^[A-Za-z0-9_-]{8,128}$" }),
    configuration: BrandConfigurationSchema,
  },
  strict,
);
export type SaveBrandingRequest = Static<typeof SaveBrandingRequestSchema>;
export interface AdminBranding {
  readonly generation: number;
  readonly configuration: BrandConfiguration;
}

export function normalizeBranding(input: unknown): BrandConfiguration {
  const value = object(input, [
    "productName",
    "logoDataUrl",
    "primaryColor",
    "footerLinks",
    "hiddenModules",
  ]);
  const productName = text(value.productName, 60);
  const primaryColor = value.primaryColor;
  if (
    primaryColor !== null &&
    (typeof primaryColor !== "string" || !/^#[0-9a-fA-F]{6}$/.test(primaryColor))
  )
    invalid();
  const logoDataUrl = value.logoDataUrl;
  if (logoDataUrl !== null) validateBrandLogo(logoDataUrl);
  if (!Array.isArray(value.footerLinks) || value.footerLinks.length > 5) invalid();
  const footerLinks = value.footerLinks.map((link: unknown) => {
    const entry = object(link, ["text", "url"]);
    const label = text(entry.text, 60);
    const address = text(entry.url, 2048);
    let url: URL;
    try {
      url = new URL(address);
    } catch {
      return invalid();
    }
    if (
      !["https:", "mailto:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      Array.from(address).some(
        (character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
      )
    )
      invalid();
    if (url.protocol === "https:" && !url.hostname) invalid();
    if (
      url.protocol === "mailto:" &&
      (!url.pathname.includes("@") || url.search || url.hash || /%0[ad]/i.test(address))
    )
      invalid();
    return { text: label, url: address };
  });
  if (
    !Array.isArray(value.hiddenModules) ||
    value.hiddenModules.some((module: unknown) => !BRAND_MODULES.includes(module as BrandModule)) ||
    new Set(value.hiddenModules).size !== value.hiddenModules.length
  )
    invalid();
  return {
    productName,
    logoDataUrl: logoDataUrl as string | null,
    primaryColor: primaryColor as string | null,
    footerLinks,
    hiddenModules: [...value.hiddenModules] as BrandModule[],
  };
}

export function validateBrandLogo(input: unknown): asserts input is string {
  if (typeof input !== "string" || input.length > 65580) invalid();
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(input);
  if (!match) invalid();
  let bytes: string;
  try {
    bytes = atob(match[2]!);
  } catch {
    return invalid();
  }
  if (bytes.length > MAX_BRAND_LOGO_BYTES || btoa(bytes) !== match[2]) invalid();
  const signature =
    match[1] === "png"
      ? bytes.startsWith("\x89PNG\r\n\x1a\n") &&
        bytes.slice(12, 16) === "IHDR" &&
        bytes.length >= 33
      : match[1] === "jpeg"
        ? bytes.startsWith("\xff\xd8\xff") && bytes.endsWith("\xff\xd9")
        : bytes.startsWith("RIFF") &&
          bytes.slice(8, 12) === "WEBP" &&
          ["VP8 ", "VP8L", "VP8X"].includes(bytes.slice(12, 16));
  if (!signature) invalid();
}

function object(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return invalid();
  const value = input as Record<string, unknown>;
  if (
    Object.keys(value).length !== keys.length ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    invalid();
  return value;
}
function text(input: unknown, maximum: number): string {
  if (
    typeof input !== "string" ||
    !input.trim() ||
    input.length > maximum ||
    Array.from(input).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    return invalid();
  return input.trim();
}
function invalid(): never {
  throw new TypeError("品牌配置无效：请检查名称、颜色、位图 Logo、链接和模块名单。");
}
