import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyIntegrity } from "@rea-web/recovery";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { capturePackage, planPreservation } from "../src/index.js";
import {
  type FixtureBuild,
  createFixtureBuild,
  describeDb,
  fullBuild,
  makeContext,
} from "./fixtureBuild.js";

const BUNDLE = '#!/usr/bin/env node\nconsole.log("fake rea-recover bundle");\n';

describeDb("embedding the verifier bundle", () => {
  let root = "";
  let fx: FixtureBuild;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "pres-embed-"));
    fx = await createFixtureBuild(join(root, "fx"));
    await mkdir(join(root, "ws"), { recursive: true });
  }, 120_000);

  afterAll(async () => {
    await fx?.cleanup();
    await rm(root, { recursive: true, force: true });
  });

  const capture = async (
    name: string,
    verifierBundlePath: string | undefined,
  ) => {
    const tc = makeContext(join(root, "ws"), fx);
    const full = fullBuild(fx);
    const build = {
      ...full,
      components: full.components.filter((c) => c.kind === "source"),
    };
    const plan = await planPreservation(build, tc.ctx);
    return capturePackage(build, plan, tc.ctx, {
      stagingDir: join(root, name),
      producerVersion: "0.0.0-test",
      ...(verifierBundlePath === undefined ? {} : { verifierBundlePath }),
    });
  };

  it("copies the bundle into recovery/ under the package component and hashes it", async () => {
    const bundle = join(root, "rea-recover.mjs");
    await writeFile(bundle, BUNDLE);
    const result = await capture("with-bundle", bundle);

    const entry = result.manifest.files.find(
      (f) => f.path === "recovery/rea-recover.mjs",
    );
    expect(entry).toMatchObject({
      component_id: "package",
      size: Buffer.byteLength(BUNDLE),
      sha256: createHash("sha256").update(BUNDLE).digest("hex"),
    });
    expect(
      await readFile(join(result.root, "recovery/rea-recover.mjs"), "utf8"),
    ).toBe(BUNDLE);
    expect(await verifyIntegrity(result.root)).toMatchObject({ ok: true });
  }, 120_000);

  it("embeds nothing unless asked to", async () => {
    const result = await capture("without-bundle", undefined);
    expect(
      result.manifest.files.some((f) => f.path === "recovery/rea-recover.mjs"),
    ).toBe(false);
  }, 120_000);
});
