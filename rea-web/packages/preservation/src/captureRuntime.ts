import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { createPackageBuilder } from "@rea-web/recovery";
import { succeeded } from "./exec.js";
import { gitEnv } from "./git.js";
import type {
  CaptureRuntime,
  CheckoutResult,
  Runtime,
  SourceInfo,
} from "./runtime.js";

const substitute = (arg: string, packageRoot: string, target: string): string =>
  arg
    .split("{{package_root}}")
    .join(packageRoot)
    .split("{{target}}")
    .join(target);

/**
 * Capture-time services for collectors: the package builder, per-component
 * scratch directories, and scan checkouts rebuilt from the captured source's
 * own restore steps (so scanners see exactly what a restorer would get).
 */
export async function createCaptureRuntime(
  base: Runtime,
  stagingDir: string,
): Promise<CaptureRuntime> {
  const builder = await createPackageBuilder({ stagingDir });
  const stageRoot = join(base.ctx.workspace, "stage");
  await mkdir(stageRoot, { recursive: true });
  const checkoutRoot = join(base.ctx.workspace, "checkouts");
  await mkdir(checkoutRoot, { recursive: true });
  const sources = new Map<string, SourceInfo>();
  const checkouts = new Map<string, Promise<CheckoutResult>>();

  const buildCheckout = async (info: SourceInfo): Promise<CheckoutResult> => {
    const target = await mkdtemp(join(checkoutRoot, "c-"));
    for (const step of info.checkoutSteps) {
      const argv = step.run.map((a) => substitute(a, builder.root, target));
      const r = await base.run(argv, {
        env: gitEnv(),
        timeoutMs: 10 * 60_000,
        maxOutputBytes: 64 * 1024 * 1024,
      });
      if (!succeeded(r))
        return {
          ok: false,
          reason: `restore step ${step.id} failed while preparing a scan checkout: ${base.failure(r)}`,
          remediation:
            "The captured source bundle could not be rebuilt in the workspace; fix the source component first.",
        };
    }
    return {
      ok: true,
      dir: join(target, info.declId),
      headSha: info.headSha,
      sourceComponentId: info.componentId,
      sourceDeclId: info.declId,
    };
  };

  let stageCounter = 0;
  return {
    ...base,
    builder,
    sources,
    registerSource: (info) => {
      sources.set(info.declId, info);
    },
    stageDir: async () => {
      stageCounter += 1;
      const dir = join(stageRoot, `s${stageCounter}`);
      await mkdir(dir, { recursive: true });
      return dir;
    },
    checkout: (declId) => {
      const info =
        declId === null
          ? [...sources.values()][0]
          : (sources.get(declId) ??
            [...sources.values()].find((x) => x.componentId === declId));
      if (info === undefined)
        return Promise.resolve<CheckoutResult>({
          ok: false,
          reason:
            declId === null
              ? "no source component was captured"
              : `source component ${declId} was not captured`,
          remediation:
            "Declare a source component and make sure it captured (see its status).",
        });
      let pending = checkouts.get(info.declId);
      if (pending === undefined) {
        pending = buildCheckout(info);
        checkouts.set(info.declId, pending);
      }
      return pending;
    },
  };
}
