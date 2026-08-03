import { resolve } from "node:path";
import { createPostgresPool, probePostgres } from "./postgres.js";
import { publishDevelopmentPptxSkill } from "./development-pptx-publisher.js";

const sourceRoot = process.argv[2];
const environment = process.env.RUNTIME_ENV;

if (environment !== "development") {
  console.error("PPTX Skill 发布失败：只允许 development 环境");
  process.exitCode = 2;
} else if (sourceRoot === undefined || sourceRoot.trim().length === 0) {
  console.error("PPTX Skill 发布失败：缺少 vendor 来源目录");
  process.exitCode = 2;
} else {
  const configuration = readConfiguration(process.env);
  if (configuration === undefined) {
    console.error("PPTX Skill 发布失败：缺少数据库或对象存储配置");
    process.exitCode = 2;
  } else {
    const pool = createPostgresPool({
      connectionString: configuration.databaseUrl,
      applicationName: "cube-runtime-development-skill-publisher",
      schema: configuration.databaseSchema,
    });
    try {
      await probePostgres(pool, configuration.migratorRole);
      const result = await publishDevelopmentPptxSkill({
        sourceRoot: resolve(sourceRoot),
        pool,
        objectStorage: configuration.objectStorage,
      });
      console.log(
        `PPTX Skill 已发布：version=${result.version} files=${result.fileCount} package=${result.packageDigest}`,
      );
    } catch {
      // 发布者不输出底层错误，避免把数据库、对象存储配置或响应细节带入日志。
      console.error("PPTX Skill 发布失败：目录、对象存储或数据库校验未通过");
      process.exitCode = 1;
    } finally {
      await pool.end();
    }
  }
}

function readConfiguration(source: NodeJS.ProcessEnv) {
  const databaseUrl = present(source.MIGRATION_DATABASE_URL);
  const databaseSchema = present(source.DATABASE_SCHEMA);
  const migratorRole = present(source.DATABASE_MIGRATOR_ROLE);
  const endpoint = present(source.S3_ENDPOINT);
  const bucket = present(source.S3_BUCKET);
  const region = present(source.S3_REGION);
  const accessKeyId = present(source.S3_ACCESS_KEY_ID);
  const secretAccessKey = present(source.S3_SECRET_ACCESS_KEY);
  const forcePathStyle = source.S3_FORCE_PATH_STYLE;
  if (
    databaseUrl === undefined ||
    databaseSchema === undefined ||
    migratorRole === undefined ||
    endpoint === undefined ||
    bucket === undefined ||
    region === undefined ||
    accessKeyId === undefined ||
    secretAccessKey === undefined ||
    (forcePathStyle !== "true" && forcePathStyle !== "false")
  ) {
    return undefined;
  }
  return Object.freeze({
    databaseUrl,
    databaseSchema,
    migratorRole,
    objectStorage: Object.freeze({
      endpoint,
      bucket,
      region,
      accessKeyId,
      secretAccessKey,
      forcePathStyle: forcePathStyle === "true",
    }),
  });
}

function present(value: string | undefined): string | undefined {
  return value === undefined || value.trim().length === 0 ? undefined : value;
}
