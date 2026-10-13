import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { gunzipSync } from "node:zlib";

export interface ProbeTool {
  readonly name: string;
  readonly inputSchema: Record<string, unknown>;
}

const PROBE = resolve(
  import.meta.dirname,
  "../../../tools/parity-matrix/probes/linux-x64-node22-no-providers.json.gz",
);

/** The upstream tool catalog captured by the parity-matrix probe. */
export const probeTools = (): ProbeTool[] => {
  const probe = JSON.parse(
    gunzipSync(readFileSync(PROBE)).toString("utf8"),
  ) as {
    tools: ProbeTool[];
  };
  return probe.tools;
};

export const probeTool = (name: string): ProbeTool => {
  const tool = probeTools().find((entry) => entry.name === name);
  if (tool === undefined) throw new Error(`probe has no tool ${name}`);
  return tool;
};
