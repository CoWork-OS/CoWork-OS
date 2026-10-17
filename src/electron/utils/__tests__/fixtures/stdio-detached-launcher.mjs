import { pathToFileURL } from "node:url";

const { installStdioErrorGuards } = await import(pathToFileURL(process.argv[2]).href);
installStdioErrorGuards([process.stdout, process.stderr]);

let uncaughtCount = 0;
process.on("uncaughtException", (error) => {
  uncaughtCount += 1;
  process.stderr.write(`uncaughtException: ${error.message}\n`);
});
process.on("message", (message) => {
  if (message !== "detach") return;
  process.stdout.write("Finishing shutdown\n");
  process.stderr.write("Flushing diagnostics\n");
  setTimeout(() => {
    process.stdout.write("Closing resources\n");
    process.stderr.write("Final diagnostics\n");
  }, 5);
  setTimeout(() => {
    process.send({ completed: true, uncaughtCount });
    process.disconnect();
  }, 30);
});
process.send("ready");
