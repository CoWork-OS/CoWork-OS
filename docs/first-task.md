# First task: release brief sample (beta preview)

This guide describes the `release-brief-v1` beta mission. It is available only in builds with the first-task beta flag enabled. The current stable `0.5.54` installer does not include this mission. Use the [getting-started guide](getting-started.md) for the released application.

The mission includes three fictional files: `release-notes.md`, `issues.csv`, and `brief-instructions.md`. It asks CoWork to create `outputs/issues-clean.csv`, `outputs/summary.json`, and `outputs/release-brief.html` in a new private sample workspace. The source has thirteen CSV data rows, twelve unique issue IDs, seven open and five closed issues, three open release blockers, and two open issues without owners.

Before launch, choose **Check model route**. This makes one small inference request that checks endpoint access, the selected model, and a harmless tool call separately. A cloud provider may charge for it. A passing check permits a sample launch for that route for ten minutes; it does not guarantee the full task will finish. The app then runs the mission through the ordinary task timeline with only workspace file tools. Shell, browser, connected services, and task-tool network access are disabled. A cloud model can still receive the sample files and may charge for inference.

After the task completes, choose **Run checks**. The packaged checker compares source hashes, the cleaned CSV, JSON facts, and HTML structure and active-content rules. A passing check is bound to output hashes. Open the brief, ask for a revision in the same task, then run the checks and open the changed brief again. The checker does not certify every sentence or recommendation. The **Try with my files** action appears after the revised brief is checked and inspected; it opens the ordinary workspace chooser with its own permissions.

For a later non-sample task, the app offers a **View output** action, asks you to confirm that you reviewed it, and then asks whether it was useful. That answer and the separate sample/revision state stay in the local profile. The synthetic sample does not count as real-work activation or as a Pulse useful task.

If authentication, model availability, tool support, permissions, cancellation, output validation, or budget limits stop the task, read the task timeline and correct that issue before starting a new attempt. Each attempt gets a separate workspace. Do not treat a text response as a checked result.

## Beta release gate

Keep the first-task route behind `VITE_FIRST_TASK_BETA=1` until packaged macOS and Windows builds pass fresh-profile and existing-profile runs without development tools. Check model-access failures, local-model offline use, interrupted startup, cancellation, changed output revalidation, keyboard navigation, and no autoplay audio. Then run the planned ten-person pilot and record counts and failure reasons. The stable website and guide should describe the sample as available only after a matching application release exists.
