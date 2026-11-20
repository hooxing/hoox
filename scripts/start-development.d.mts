export interface DevelopmentStartOptions {
  skipBuild: boolean;
  coreOnly: boolean;
  includeSkill: boolean;
  noBrowser: boolean;
}

export function parseDotEnv(source: string): Record<string, string>;
export function parseArgs(args: string[]): DevelopmentStartOptions;
