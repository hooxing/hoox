import {
  DEFAULT_BRANDING,
  normalizeBranding,
  type BrandConfiguration,
  type BrandModule,
} from "@hoox/protocol";
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
  type ImgHTMLAttributes,
} from "react";

const BrandContext = createContext({
  configuration: DEFAULT_BRANDING,
  update: (_configuration: BrandConfiguration): void => {},
  defaultTokens: {} as Record<string, string>,
});
export const useBranding = () => useContext(BrandContext);
export function BrandLogo({
  showName = true,
  ...props
}: ImgHTMLAttributes<HTMLImageElement> & { readonly showName?: boolean }) {
  const { configuration } = useBranding();
  const custom = configuration.productName !== "Hoox" || configuration.logoDataUrl !== null;
  if (!custom) return <img {...props} alt={props.alt ?? ""} />;
  if (!showName)
    return <img {...props} src={configuration.logoDataUrl ?? props.src} alt={props.alt ?? ""} />;
  return (
    <span className="custom-brand-logo">
      {configuration.logoDataUrl && <img {...props} src={configuration.logoDataUrl} alt="" />}
      <span>{configuration.productName}</span>
    </span>
  );
}
export function moduleVisible(configuration: BrandConfiguration, module: BrandModule): boolean {
  return !configuration.hiddenModules.includes(module);
}
export function BrandingProvider({
  children,
  initial,
  load = true,
}: {
  readonly children: ReactNode;
  readonly initial?: BrandConfiguration;
  readonly load?: boolean;
}) {
  const [configuration, update] = useState(() => normalizeBranding(initial ?? DEFAULT_BRANDING));
  const [defaultTokens] = useState(() => {
    if (typeof document === "undefined") return {};
    const computed = getComputedStyle(document.documentElement);
    return Object.fromEntries(
      Object.keys(brandingTokens("#000000"))
        .map((key) => [key, computed.getPropertyValue(key)])
        .filter(([, value]) => value),
    );
  });
  useEffect(() => {
    if (!load) return;
    const controller = new AbortController();
    void fetch("/api/v1/public/branding", {
      cache: "no-store",
      credentials: "omit",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("BRANDING_UNAVAILABLE");
        const envelope = (await response.json()) as { data: unknown };
        if (!controller.signal.aborted) update(normalizeBranding(envelope.data));
      })
      .catch(() => {});
    return () => controller.abort();
  }, [load]);
  useEffect(() => {
    const root = document.documentElement;
    const originalTitle = document.title;
    const tokens = brandingTokens(configuration.primaryColor);
    const previous = Object.keys(tokens).map(
      (key) => [key, root.style.getPropertyValue(key)] as const,
    );
    for (const [key, value] of Object.entries(tokens)) root.style.setProperty(key, value);
    if (configuration.productName !== "Hoox")
      document.title = originalTitle.replace("Hoox", configuration.productName);
    const icons = Array.from(
      document.querySelectorAll<HTMLLinkElement>('link[rel="icon"],link[rel="apple-touch-icon"]'),
    );
    const previousIcons = icons.map(
      (icon) => [icon, icon.getAttribute("href"), icon.getAttribute("type")] as const,
    );
    if (configuration.logoDataUrl)
      for (const icon of icons) {
        icon.href = configuration.logoDataUrl;
        icon.removeAttribute("type");
      }
    return () => {
      document.title = originalTitle;
      for (const [key, value] of previous) {
        if (value) root.style.setProperty(key, value);
        else root.style.removeProperty(key);
      }
      for (const [icon, href, type] of previousIcons) {
        if (href === null) icon.removeAttribute("href");
        else icon.setAttribute("href", href);
        if (type === null) icon.removeAttribute("type");
        else icon.setAttribute("type", type);
      }
    };
  }, [configuration]);
  return (
    <BrandContext.Provider value={{ configuration, update, defaultTokens }}>
      {children}
    </BrandContext.Provider>
  );
}
export function BrandingFooter() {
  const { configuration } = useBranding();
  return configuration.footerLinks.length === 0 ? null : (
    <footer className="branding-footer" role="contentinfo" aria-label="平台链接">
      {configuration.footerLinks.map((link) => (
        <a
          key={`${link.text}:${link.url}`}
          href={link.url}
          target="_blank"
          rel="noopener noreferrer"
        >
          {link.text}
        </a>
      ))}
    </footer>
  );
}
export function brandingTokens(color: string | null): Record<string, string> {
  if (color === null) return {};
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) throw new TypeError("品牌主色必须是六位十六进制颜色");
  const foreground = brandForeground(color);
  const hover = mix(color, foreground === "#ffffff" ? 0 : 255, 0.12);
  const active = mix(color, foreground === "#ffffff" ? 0 : 255, 0.24);
  let accent = color;
  while (contrast(accent, "#f2f0ed") < 4.5) accent = mix(accent, 0, 0.1);
  return {
    "--brand-green": accent,
    "--action-primary": color,
    "--action-primary-hover": hover,
    "--action-primary-active": active,
    "--action-primary-text": foreground,
    "--action-primary-link": accent,
    "--focus-color": accent,
    "--focus-ring": `${accent}2e`,
  };
}
export function brandForeground(color: string): string {
  return contrast(color, "#ffffff") >= contrast(color, "#000000") ? "#ffffff" : "#000000";
}
export function contrast(first: string, second: string): number {
  const luminance = (color: string) =>
    channels(color)
      .map((channel) => {
        const value = channel / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      })
      .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index]!, 0);
  const firstLuminance = luminance(first);
  const secondLuminance = luminance(second);
  return (
    (Math.max(firstLuminance, secondLuminance) + 0.05) /
    (Math.min(firstLuminance, secondLuminance) + 0.05)
  );
}
function channels(color: string): number[] {
  return [1, 3, 5].map((offset) => Number.parseInt(color.slice(offset, offset + 2), 16));
}
function mix(color: string, target: number, weight: number): string {
  return `#${channels(color)
    .map((channel) =>
      Math.round(channel * (1 - weight) + target * weight)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}
