const { verifyArtifact } = require("./battery_artifact_graders.cjs");

async function main() {
  const request = JSON.parse(process.argv[2] || "{}");
  const result = await verifyArtifact(
    request.kind,
    request.path,
    request.runId,
    request.options || {},
  );
  process.stdout.write(JSON.stringify(result));
}

main().catch((error) => {
  process.stdout.write(
    JSON.stringify({
      ok: false,
      error: "grader_worker_failed",
      detail: String(error.message || error),
    }),
  );
  process.exitCode = 1;
});
