import { z } from "zod";

const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/u;
const argv = z.array(z.string()).min(1);

const volumeSchema = z.union([
  z
    .string()
    .min(1)
    .transform((name) => ({
      name,
      mount_path: null as string | null,
      size_gb: null as number | null,
    })),
  z
    .object({
      name: z.string().min(1),
      mount_path: z.string().nullable().default(null),
      size_gb: z.number().nonnegative().nullable().default(null),
    })
    .strict(),
]);

export const serviceSchema = z
  .object({
    name: z.string().min(1),
    kind: z.string().min(1).default("web"),
    build_command: argv.nullable().default(null),
    start_command: argv.nullable().default(null),
    health_check: z
      .object({ path: z.string().optional(), command: argv.optional() })
      .strict()
      .nullable()
      .default(null),
    region: z.string().nullable().default(null),
    volumes: z.array(volumeSchema).default([]),
    depends_on: z.array(z.string()).default([]),
  })
  .strict();

export const scheduleSchema = z
  .object({ name: z.string().min(1), cron: z.string().min(1), command: argv })
  .strict();

const domainSchema = z.union([
  z
    .string()
    .min(1)
    .transform((host) => ({ host, purpose: null as string | null })),
  z
    .object({
      host: z.string().min(1),
      purpose: z.string().nullable().default(null),
    })
    .strict(),
]);

export const behaviorCheckSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .regex(
        /^[A-Za-z0-9._-]+$/u,
        "id may contain letters, digits, '.', '_' and '-' only",
      ),
    title: z.string().min(1),
    run: argv,
    cwd: z.enum(["source", "package"]).default("source"),
    expect_exit: z.number().int().default(0),
    timeout_ms: z.number().int().positive().default(60_000),
  })
  .strict();

export const infrastructureDescriptorSchema = z
  .object({
    services: z.array(serviceSchema).default([]),
    schedules: z.array(scheduleSchema).default([]),
    domains: z.array(domainSchema).default([]),
    env_names: z
      .array(
        z.string().regex(ENV_NAME, "must be an UPPER_SNAKE_CASE variable name"),
      )
      .default([]),
    secret_refs: z
      .array(
        z
          .object({
            name: z
              .string()
              .regex(ENV_NAME, "must be an UPPER_SNAKE_CASE variable name"),
            store: z.string().min(1),
          })
          .strict(),
      )
      .default([]),
    behavior_checks: z.array(behaviorCheckSchema).default([]),
  })
  .strict();
export type InfrastructureDescriptor = z.infer<
  typeof infrastructureDescriptorSchema
>;

const webhookSchema = z
  .object({ url: z.string().min(1), events: z.array(z.string()).default([]) })
  .strict();

export const providerSchema = z
  .object({
    name: z.string().min(1),
    api_version: z.string().nullable().default(null),
    scopes: z.array(z.string()).default([]),
    webhooks: z.array(webhookSchema).default([]),
    callbacks: z.array(z.string()).default([]),
    account_owner: z.string().nullable().default(null),
    manual_steps: z.array(z.string()).default([]),
  })
  .strict();

export const integrationsDescriptorSchema = z
  .object({ providers: z.array(providerSchema).default([]) })
  .strict();
export type IntegrationsDescriptor = z.infer<
  typeof integrationsDescriptorSchema
>;

export type Parsed<T> =
  | { ok: true; value: T }
  | { ok: false; issues: string[] };

/** Validate a user descriptor; issues name the offending path, never the value. */
export const parseDescriptor = <S extends z.ZodType>(
  schema: S,
  raw: unknown,
): Parsed<z.output<S>> => {
  const result = schema.safeParse(raw);
  if (result.success) return { ok: true, value: result.data };
  return {
    ok: false,
    issues: result.error.issues
      .slice(0, 20)
      .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`),
  };
};
