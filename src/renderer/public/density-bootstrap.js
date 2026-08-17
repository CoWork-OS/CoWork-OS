(function () {
  try {
    const validDensities = ["focused", "full", "power"];
    const savedDensity = localStorage.getItem("uiDensity");
    if (validDensities.includes(savedDensity)) {
      const root = document.documentElement;
      root.classList.remove(...validDensities.map((density) => `density-${density}`));
      root.classList.add(`density-${savedDensity}`);
    }
  } catch {
    // Intentionally ignore bootstrap errors to avoid blocking app load.
  }
})();
