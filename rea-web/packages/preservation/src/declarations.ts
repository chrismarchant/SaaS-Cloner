import type { CollectorContext } from "./types.js";
import {
  type BuildDefinition,
  type ComponentDeclaration,
  type ComponentKind,
  componentId,
} from "./types.js";
import { urlUserinfo, extendRedactor } from "./util.js";
import { parsePgUrl } from "./collectors/data.js";

/** Capture order: stateful components are read late, data before assets. */
export const KIND_ORDER: readonly ComponentKind[] = [
  "source",
  "dependencies",
  "data",
  "assets",
  "infrastructure",
  "integrations",
  "product",
  "artifacts",
];

export const orderedDeclarations = (
  build: BuildDefinition,
): ComponentDeclaration[] =>
  [...build.components].sort(
    (a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind),
  );

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

/** Problems that make a declaration unusable as a package path; empty when fine. */
export const declarationProblems = (build: BuildDefinition): string[] => {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const decl of build.components) {
    const cid = componentId(decl);
    if (!SAFE_ID.test(decl.id))
      problems.push(
        `component id ${JSON.stringify(decl.id)} must match ${SAFE_ID.source} to be used as a package path segment`,
      );
    if (seen.has(cid.toLowerCase()))
      problems.push(`duplicate component declaration ${cid}`);
    seen.add(cid.toLowerCase());
  }
  return problems;
};

/**
 * Redactor that additionally knows the literal secret values the build's
 * declarations point at (connection strings and their passwords, storage
 * credentials, URL userinfo), looked up from the environment by name.
 */
export const redactorForBuild = (
  build: BuildDefinition,
  ctx: CollectorContext,
): CollectorContext["redactor"] => {
  const values: string[] = [];
  const add = (v: string | undefined): void => {
    if (v !== undefined && v !== "") values.push(v);
  };
  if (build.source.kind === "git") {
    const info = urlUserinfo(build.source.url);
    if (info !== null) {
      add(info.password);
      add(info.user);
    }
  }
  for (const decl of build.components) {
    if (decl.kind === "data") {
      const raw = ctx.env[decl.connection_env_name];
      add(raw);
      if (raw !== undefined) {
        const conn = parsePgUrl(raw);
        if (!("error" in conn)) add(conn.password);
      }
    } else if (
      decl.kind === "assets" &&
      "credentials_env_prefix" in decl.source
    ) {
      const prefix = `${decl.source.credentials_env_prefix}_`;
      for (const [name, value] of Object.entries(ctx.env))
        if (name.startsWith(prefix)) add(value);
    }
  }
  return extendRedactor(ctx.redactor, values);
};
