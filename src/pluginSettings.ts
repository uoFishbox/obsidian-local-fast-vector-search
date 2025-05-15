export interface PluginSettings {
	provider: string;
	verboseLoggingEnabled: boolean;
}

export const DEFAULT_SETTINGS: PluginSettings = {
	provider: "transformers.js",
	verboseLoggingEnabled: false,
};
