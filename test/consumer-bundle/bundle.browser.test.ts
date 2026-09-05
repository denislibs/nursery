// Runs the consumer bundles produced by scripts/check-consumer-bundle.mjs in real browsers.
// Firefox and WebKit ship without Symbol.dispose, so a bundle that lost the polyfill fails
// to even evaluate there.
const bundles = ['esbuild', 'vite', 'webpack'] as const;

for (const bundler of bundles) {
  describe(`consumer bundle: ${bundler}`, () => {
    it('evaluates and runs a nursery', async () => {
      const mod = (await import(`./.out/${bundler}.js`)) as {
        hasDisposeSymbols: boolean;
        probe: () => Promise<{ value: string; wrapIsFunction: boolean }>;
      };
      expect(mod.hasDisposeSymbols).toBe(true);
      await expect(mod.probe()).resolves.toEqual({ value: 'ok', wrapIsFunction: true });
    });
  });
}

it('exposes the polyfill as a subpath for consumers who load it themselves', async () => {
  await expect(import('@nursery/core/polyfill')).resolves.toBeDefined();
});
