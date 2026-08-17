import { UI_DENSITIES, type UiDensity } from "../../shared/types";

type DensityClassTarget = {
  classList: Pick<DOMTokenList, "add" | "remove">;
};

const UI_DENSITY_CLASSES = UI_DENSITIES.map((density) => `density-${density}`);

export function applyUiDensityClass(target: DensityClassTarget, density: UiDensity): void {
  target.classList.remove(...UI_DENSITY_CLASSES);
  target.classList.add(`density-${density}`);
}
