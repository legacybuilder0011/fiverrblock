(() => {
  if (globalThis.__scrollRefreshMotion) return;
  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
  const ease = (t) => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  function plan(start, height, maximum, random = Math.random) {
    const direction = maximum - start < height * 0.6 ? -1 : 1;
    let current = start;
    const steps = [];
    const add = (distance) => {
      current = clamp(current + direction * distance, 0, maximum);
      steps.push({ top: current, duration: 550 + random() * 550, pause: 800 + random() * 1000 });
    };
    add(height * (0.25 + random() * 0.2));
    add(height * (0.65 + random() * 0.4));
    if (random() < 0.7) add(-height * (0.15 + random() * 0.2));
    add(height * (0.3 + random() * 0.35));
    steps.push({ top: start, duration: 700 + random() * 350, pause: 500 + random() * 300 });
    return steps;
  }
  globalThis.__scrollRefreshMotion = { ease, plan };
})();
