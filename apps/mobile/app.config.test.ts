import { afterEach, expect, it, vi } from "vite-plus/test";

// Keep config parsing independent of local env files and build credentials.
vi.mock("../../scripts/lib/public-config.ts", () => ({
  loadRepoEnv: () => ({ APP_VARIANT: process.env.APP_VARIANT }),
}));

afterEach(() => {
  vi.unstubAllEnvs();
});

async function loadConfig(variant: string | undefined) {
  vi.resetModules();
  vi.stubEnv("APP_VARIANT", variant);
  return (await import("./app.config.ts")).default;
}

it.each(["prod", ""])("rejects APP_VARIANT=%j before selecting production IDs", async (value) => {
  await expect(loadConfig(value)).rejects.toThrow(
    "APP_VARIANT must be development, preview, or production.",
  );
});

it.each([
  [undefined, "com.ccdriver.personal"],
  ["development", "com.ccdriver.personal.dev"],
  ["preview", "com.ccdriver.personal.preview"],
  ["production", "com.ccdriver.personal"],
])("keeps the iOS and Android identifiers for APP_VARIANT=%j", async (value, identifier) => {
  const config = await loadConfig(value);
  expect(config.ios?.bundleIdentifier).toBe(identifier);
  expect(config.android?.package).toBe(identifier);
  expect(config.owner).toBeUndefined();
  expect(config.updates?.enabled).toBe(false);
  expect(config.updates?.url).toBeUndefined();
  expect(config.ios?.appleTeamId).toBeUndefined();
  expect(config.ios?.associatedDomains).toEqual([]);
  expect(config.android?.intentFilters).toEqual([]);
  expect(config.extra?.eas?.projectId).toBeUndefined();
  expect(config.extra?.relay?.url).toBeNull();
  expect(config.extra?.clerk?.publishableKey).toBeNull();
  expect(config.extra?.observability?.tracesToken).toBeNull();
});
