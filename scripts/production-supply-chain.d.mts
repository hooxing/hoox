export interface CycloneDxComponent {
  readonly type: string;
  readonly "bom-ref": string;
  readonly name: string;
  readonly version: string;
  readonly purl: string;
  readonly licenses?: readonly [{ readonly license: { readonly id: string } }];
  readonly properties: readonly { readonly name: string; readonly value: string }[];
}

export interface CycloneDxBom {
  readonly bomFormat: "CycloneDX";
  readonly specVersion: "1.6";
  readonly version: 1;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly components: readonly CycloneDxComponent[];
  readonly dependencies: readonly Readonly<Record<string, unknown>>[];
}

export const productionSbomTargets: readonly Readonly<{
  id: "api" | "scheduler" | "worker";
  packageName: string;
  fileName: string;
}>[];

export function canonicalVendorTreeSha256(directory: string): string;
export function verifyReverseApplicablePatch(patchPath: string): boolean;
export function canonicalizeProductionPlatformComponents(
  components: readonly CycloneDxComponent[],
): readonly CycloneDxComponent[];

export function buildCycloneDx(input: {
  readonly root: { readonly name: string; readonly version: string };
  readonly components: readonly CycloneDxComponent[];
  readonly lockfileSha256: string;
}): CycloneDxBom;

export function evaluateLicensePolicy(
  components: readonly CycloneDxComponent[],
  policy: Readonly<{ readonly allowed?: readonly string[]; readonly denied?: readonly string[] }>,
): string[];

export function validateVendorEvidence(policy: Readonly<Record<string, unknown>>): string[];
export function generateProductionSboms(): readonly Readonly<{
  target: (typeof productionSbomTargets)[number];
  bom: CycloneDxBom;
  serialized: string;
}>[];
export function validateProductionSupplyChain(
  input?: Readonly<{
    generated?: ReturnType<typeof generateProductionSboms>;
  }>,
): string[];
