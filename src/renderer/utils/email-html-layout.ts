function finiteLayoutNumber(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function computeEmailFitScale(availableWidth: number, contentWidth: number): number {
  if (!Number.isFinite(availableWidth) || availableWidth <= 0) return 1;

  const layoutWidth = Math.max(
    1,
    finiteLayoutNumber(contentWidth),
    finiteLayoutNumber(availableWidth),
  );
  const safetyInset = getEmailFitInset(availableWidth);
  const fitWidth = Math.max(1, availableWidth - safetyInset);

  return Math.min(1, fitWidth / layoutWidth);
}

export function getEmailFitInset(availableWidth: number): number {
  if (!Number.isFinite(availableWidth) || availableWidth <= 0) return 0;
  return Math.min(96, Math.max(40, availableWidth * 0.07));
}

export function measureEmailContentWidth(doc: Document, root: HTMLElement): number {
  const docEl = doc.documentElement;
  const body = doc.body;
  const rootRect = root.getBoundingClientRect();
  const rootLeft = Number.isFinite(rootRect.left) ? rootRect.left : 0;
  let contentWidth = Math.max(
    finiteLayoutNumber(root.scrollWidth),
    finiteLayoutNumber(root.offsetWidth),
    finiteLayoutNumber(rootRect.width),
    finiteLayoutNumber(body?.scrollWidth),
    finiteLayoutNumber(docEl?.scrollWidth),
  );

  const elements = [root, ...Array.from(root.querySelectorAll<HTMLElement>("*"))];
  for (const element of elements) {
    const rect = element.getBoundingClientRect();
    if (!Number.isFinite(rect.left) || !Number.isFinite(rect.right)) continue;

    const relativeLeft = Math.max(0, rect.left - rootLeft);
    const paintedRight = Math.max(0, rect.right - rootLeft);
    const scrollRight =
      relativeLeft +
      Math.max(
        finiteLayoutNumber(element.scrollWidth),
        finiteLayoutNumber(element.offsetWidth),
        finiteLayoutNumber(rect.width),
      );
    contentWidth = Math.max(contentWidth, paintedRight, scrollRight);
  }

  return Math.ceil(contentWidth);
}
