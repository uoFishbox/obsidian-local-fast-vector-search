export interface PluginSettings {
	provider: string;
	verboseLoggingEnabled: boolean;
	searchResultLimit: number;
}

export const DEFAULT_SETTINGS: PluginSettings = {
	provider: "transformers.js",
	verboseLoggingEnabled: false,
	searchResultLimit: 100,
};
