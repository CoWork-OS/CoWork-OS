/**
 * Command arguments typed into one text field: separated by whitespace, with
 * "double" or 'single' quotes keeping spaces inside one argument
 * (`--root "/Users/me/My Documents"`). Backslashes are literal so Windows
 * paths survive.
 */
export function parseCommandArgs(text: string): string[] {
  const args: string[] = [];
  let current = "";
  let inArg = false;
  let quote: '"' | "'" | null = null;
  for (const char of String(text || "")) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      inArg = true;
    } else if (/\s/.test(char)) {
      if (inArg) args.push(current);
      current = "";
      inArg = false;
    } else {
      current += char;
      inArg = true;
    }
  }
  if (inArg) args.push(current);
  return args;
}

/** The text that parseCommandArgs reads back as the same arguments. */
export function formatCommandArgs(args: readonly string[] | undefined): string {
  return (args ?? [])
    .map((arg) => {
      if (arg !== "" && !/[\s"']/.test(arg)) return arg;
      return arg.includes('"') ? `'${arg}'` : `"${arg}"`;
    })
    .join(" ");
}
