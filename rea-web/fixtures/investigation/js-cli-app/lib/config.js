/** Configuration is read from the environment; secret values never live in source. */
export const loadConfig = (env) => ({
  storePath: env.NOTES_STORE_PATH ?? "./notes.json",
  port: Number(env.NOTES_PORT ?? 4310),
  syncEndpoint:
    env.NOTES_SYNC_ENDPOINT ?? "https://sync.example.invalid/v1/notes",
  syncToken: env.NOTES_SYNC_TOKEN ?? null,
});
