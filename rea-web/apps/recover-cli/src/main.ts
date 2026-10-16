import { runCli } from "./cli.js";

const code = await runCli(process.argv.slice(2), process.env, {
  stdout: (text) => void process.stdout.write(text),
  stderr: (text) => void process.stderr.write(text),
});
// Let buffered output flush before exiting.
process.exitCode = code;
