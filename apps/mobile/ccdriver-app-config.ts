import type { ExpoConfig } from "expo/config";

export function personalAgentConfig(
  base: ExpoConfig,
  variant: "development" | "preview" | "production",
): ExpoConfig {
  const suffix = variant === "production" ? "" : variant === "development" ? ".dev" : ".preview";
  const identifier = `com.ccdriver.personal${suffix}`;
  return {
    ...base,
    name:
      variant === "production"
        ? "ccdriver"
        : `ccdriver ${variant === "development" ? "Dev" : "Preview"}`,
    slug: "ccdriver-personal",
    scheme: `ccdriver${variant === "production" ? "" : variant === "development" ? "-dev" : "-preview"}`,
    owner: undefined,
    updates: { enabled: false, checkAutomatically: "NEVER" },
    ios: {
      ...base.ios,
      bundleIdentifier: identifier,
      appleTeamId: undefined,
      associatedDomains: [],
      entitlements: { "keychain-access-groups": [`$(AppIdentifierPrefix)${identifier}`] },
      infoPlist: {
        ...base.ios?.infoPlist,
        NSLocalNetworkUsageDescription: "Allow ccdriver to connect to your personal Agent server.",
      },
    },
    android: {
      ...base.android,
      package: identifier,
      intentFilters: [],
      googleServicesFile: undefined,
    },
    plugins: base.plugins?.filter((plugin) => {
      const name = typeof plugin === "string" ? plugin : plugin[0];
      return (
        name !== "expo-widgets" &&
        name !== "./plugins/withWidgetLogoAsset.cjs" &&
        name !== "@clerk/expo"
      );
    }),
    extra: {
      appVariant: variant,
      secretsFeatureEnabled: false,
      iosPersonalTeamBuild: base.extra?.iosPersonalTeamBuild ?? false,
      relay: { url: null },
      clerk: { publishableKey: null, jwtTemplate: null },
      observability: { tracesUrl: null, tracesDataset: null, tracesToken: null },
      eas: { observe: { endpointUrl: "https://observe.invalid" } },
    },
  };
}
