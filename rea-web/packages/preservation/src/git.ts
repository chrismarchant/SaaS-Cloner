import { urlUserinfo } from "./util.js";

/** Environment for git children: explicit, minimal, never prompting. */
export const gitEnv = (
  extra: Record<string, string> = {},
): Record<string, string> => {
  const env: Record<string, string> = {
    LC_ALL: "C",
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_ASKPASS: "true",
  };
  for (const name of [
    "PATH",
    "HOME",
    "XDG_CONFIG_HOME",
    "SSH_AUTH_SOCK",
    "TMPDIR",
  ]) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return { ...env, ...extra };
};

/**
 * `git -C <dir> ...` with hazards removed: no fsmonitor hook, no repository
 * hooks, no `ext::` transport (which runs commands named in a URL), no pager,
 * and ownership checks relaxed because capture only reads the repository.
 */
export const gitArgv = (dir: string, args: string[]): string[] => [
  "git",
  "-c",
  "safe.directory=*",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "protocol.ext.allow=never",
  "-C",
  dir,
  ...args,
];

/**
 * Credentials embedded in a remote URL are handed to git through a
 * credential helper reading environment variables, so they never appear on
 * argv or in the stored remote URL.
 */
export const credentialEnv = (url: string): Record<string, string> => {
  const info = urlUserinfo(url);
  if (info === null) return {};
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0:
      '!f() { test "$1" = get && { echo "username=$REA_GIT_USER"; echo "password=$REA_GIT_PASS"; }; }; f',
    REA_GIT_USER: info.user,
    REA_GIT_PASS: info.password,
  };
};

export const withoutUserinfo = (url: string): string => {
  const info = urlUserinfo(url);
  if (info === null) return url;
  try {
    const u = new URL(url);
    u.username = "";
    u.password = "";
    return u.toString();
  } catch {
    return url;
  }
};

/** Flags that stop git-lfs smudging during clone/checkout (no network needed). */
export const LFS_SKIP_SMUDGE: string[] = [
  "-c",
  "filter.lfs.smudge=",
  "-c",
  "filter.lfs.process=",
  "-c",
  "filter.lfs.required=false",
];
