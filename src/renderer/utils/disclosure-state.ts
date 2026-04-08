interface ResolveDisclosureExpandedOptions {
  forceExpanded?: boolean;
  defaultExpanded?: boolean;
  toggled?: boolean;
}

export function resolveDisclosureExpanded({
  forceExpanded = false,
  defaultExpanded = false,
  toggled = false,
}: ResolveDisclosureExpandedOptions): boolean {
  if (forceExpanded) return true;
  return defaultExpanded ? !toggled : toggled;
}
