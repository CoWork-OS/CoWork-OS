(function () {
  try {
    const savedDensity = localStorage.getItem('uiDensity');
    if (savedDensity === 'focused' || savedDensity === 'full') {
      const root = document.documentElement;
      root.classList.remove('density-focused', 'density-full');
      root.classList.add(`density-${savedDensity}`);
    }
  } catch (error) {
    // Intentionally ignore bootstrap errors to avoid blocking app load.
  }
})();
