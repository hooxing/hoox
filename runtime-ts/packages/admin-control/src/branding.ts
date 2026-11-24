import type { AdminBranding, BrandConfiguration, SaveBrandingRequest } from "@hoox/protocol";

export interface BrandingAdminPort {
  read(userId: string): Promise<AdminBranding>;
  save(userId: string, input: SaveBrandingRequest): Promise<AdminBranding>;
}
export interface PublicBrandingPort {
  read(): Promise<BrandConfiguration>;
}
export class BrandingError extends Error {
  constructor(readonly kind: "forbidden" | "conflict") {
    super(kind);
  }
}
