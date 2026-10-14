/** Editable native files require an application workflow, not a raster generator. */
export function hasNativeApplicationOutputIntent(text: string): boolean {
  const value = text.toLowerCase();
  return (
    (/\bphotoshop\b/.test(value) && /\b(?:editable|psd|layers?)\b/.test(value)) ||
    /\.psd\b/.test(value) ||
    (/\bexcel\b/.test(value) && /\boperating[- ]plan\b/.test(value))
  );
}

/** Returning existing results does not dispatch another application mutation. */
export function isNativeApplicationPresentationStep(
  taskText: string,
  description: string,
): boolean {
  if (!hasNativeApplicationOutputIntent(taskText)) return false;
  const value = description.trim();
  return (
    /^(?:produce|provide|write|compose|deliver|present|show|summarize)\s+(?:the\s+)?(?:complete\s+)?(?:final\s+)?(?:reply|response|summary|results?)\b/i.test(
      value,
    ) &&
    !/\b(?:then|and|also)\s+(?:create|edit|apply|execute|save|export|modify|update|delete|rename)\b/i.test(
      value,
    )
  );
}

/** File names are targets, not verbs: "background-edit.psd" is not an edit. */
function withoutFileNames(description: string): string {
  return description
    .toLowerCase()
    .trim()
    .replace(/[\w./~-]*[\w-]\.[a-z][a-z0-9]{0,9}\b/g, " file ");
}

/**
 * A step performed through generic background UI control (native_app). Its
 * writer is the app itself, so it must not infer a file or scripting writer;
 * the saved result is proven by a later readback step.
 */
export function isNativeUiOperationStep(description: string): boolean {
  const value = withoutFileNames(description);
  return /\bnative_app\b|\bnative (?:ui|window|accessibility)\b|\bbackground (?:native )?(?:ui|keypress(?:es)?|key press(?:es)?|window(?:-scoped)?|accessibility)\b|\baccessibility (?:state|controls?|tokens?)\b/.test(
    value,
  );
}

/** Checking the result of an edit is not another edit instruction. */
export function isNativeApplicationReadbackStep(taskText: string, description: string): boolean {
  if (!hasNativeApplicationOutputIntent(taskText)) return false;
  const value = withoutFileNames(description);
  const actions = value.replace(
    /\b(?:original|prepared|requested|completed)\s+edit\s+operation\b/g,
    "operation",
  );
  return (
    /^(?:independently\s+)?(?:verify|inspect|check|confirm|validate)\b/.test(value) &&
    /\b(?:readback|saved|outputs?|hash(?:es)?|sha-?256)\b/.test(value) &&
    !/\b(?:write_file|edit_file|delete_file|rename_file)\b/.test(value) &&
    !/\b(?:write|edit|apply|execute|save|export|create|modify|update|append|delete|rename)\b/.test(
      actions,
    )
  );
}

/** File/layer preconditions do not create an output just because they name it. */
export function isNativeApplicationPreparationStep(taskText: string, description: string): boolean {
  if (!hasNativeApplicationOutputIntent(taskText)) return false;
  if (isNativeApplicationReadbackStep(taskText, description)) return true;
  const value = withoutFileNames(description);
  // A prepared application operation is a journaled proposal, not a request
  // to manufacture a workspace manifest. Desired layer edits remain data.
  if (/^prepare\b/.test(value)) {
    const proposal = value.replace(
      /\b(?:do not|without|before)\s+(?:executing|applying|saving|exporting|execute|apply|save|export)\b/g,
      " ",
    );
    return !/\b(?:execute|apply|save|export|write_file|edit_file|write|delete_file|rename_file)\b/.test(
      proposal,
    );
  }
  if (
    !/^(?:inspect|read|check|confirm|identify|validate|ensure|discover|find|locate|observe)\b/.test(
      value,
    )
  )
    return false;
  const positive = value.replace(
    /\bbefore\s+(?:editing|saving|writing|exporting|applying)(?:\s+changes)?\b/g,
    " ",
  );
  return !/\b(?:write_file|edit_file|write|create|save|export|apply|edit|change|update|rename|move|delete|remove|replace|set|translate|hide|show)\b/.test(
    positive,
  );
}
