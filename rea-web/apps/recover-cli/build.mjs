// Bundles the verifier/restorer into one self-contained file that runs on
// Node 22 without node_modules or any other part of the repository.
import { chmod, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = new URL("./", import.meta.url);
const { version } = JSON.parse(
  await readFile(new URL("package.json", here), "utf8"),
);

await build({
  entryPoints: [fileURLToPath(new URL("src/main.ts", here))],
  outfile: fileURLToPath(new URL("dist/rea-recover.mjs", here)),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: false,
  legalComments: "none",
  define: { __REA_RECOVER_VERSION__: JSON.stringify(version) },
  banner: {
    js: [
      "#!/usr/bin/env node",
      'import { createRequire as __reaCreateRequire } from "node:module";',
      "const require = __reaCreateRequire(import.meta.url);",
    ].join("\n"),
  },
  logLevel: "warning",
});
await chmod(fileURLToPath(new URL("dist/rea-recover.mjs", here)), 0o755);
