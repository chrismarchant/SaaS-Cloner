import { createFsObjectStore } from "./fs.js";
import { createS3ObjectStore, type S3ObjectStoreOptions } from "./s3.js";
import type { ObjectStore } from "./types.js";

type Env = Readonly<Record<string, string | undefined>>;

const required = (env: Env, name: string): string => {
  const value = env[name];
  if (value === undefined || value === "")
    throw new Error(`Missing required environment variable ${name}`);
  return value;
};

const optional = (env: Env, name: string): string | undefined => {
  const value = env[name];
  return value === undefined || value === "" ? undefined : value;
};

const optionalBoolean = (env: Env, name: string): boolean | undefined => {
  const value = optional(env, name);
  if (value === undefined) return undefined;
  switch (value.toLowerCase()) {
    case "1":
    case "true":
      return true;
    case "0":
    case "false":
      return false;
    default:
      throw new Error(`Environment variable ${name} must be true or false`);
  }
};

/**
 * Build the configured object store. Errors name the offending variable and
 * never include any configured value.
 */
export function createObjectStoreFromEnv(env: Env): ObjectStore {
  const backend = required(env, "REA_WEB_STORAGE_BACKEND");
  if (backend === "fs")
    return createFsObjectStore({
      root: required(env, "REA_WEB_STORAGE_FS_ROOT"),
    });
  if (backend === "s3") {
    const endpoint = optional(env, "REA_WEB_S3_ENDPOINT");
    const forcePathStyle = optionalBoolean(env, "REA_WEB_S3_FORCE_PATH_STYLE");
    const prefix = optional(env, "REA_WEB_S3_PREFIX");
    const options: S3ObjectStoreOptions = {
      bucket: required(env, "REA_WEB_S3_BUCKET"),
      region: required(env, "REA_WEB_S3_REGION"),
      accessKeyId: required(env, "REA_WEB_S3_ACCESS_KEY_ID"),
      secretAccessKey: required(env, "REA_WEB_S3_SECRET_ACCESS_KEY"),
      ...(endpoint === undefined ? {} : { endpoint }),
      ...(forcePathStyle === undefined ? {} : { forcePathStyle }),
      ...(prefix === undefined ? {} : { prefix }),
    };
    return createS3ObjectStore(options);
  }
  throw new Error(
    "Environment variable REA_WEB_STORAGE_BACKEND must be fs or s3",
  );
}
