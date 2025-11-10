export interface PluginSettings {
	provider: string;
	verboseLoggingEnabled: boolean;
	searchResultLimit: number;
	relatedChunksResultLimit: number;
	autoShowRelatedChunksSidebar: boolean;
	expandRelatedChunksFileGroups: boolean;
	excludeHeadersInVectorization: boolean;
}

export const DEFAULT_SETTINGS: PluginSettings = {
	provider: "transformers.js",
	verboseLoggingEnabled: false,
	searchResultLimit: 100,
	relatedChunksResultLimit: 30,
	autoShowRelatedChunksSidebar: true,
	expandRelatedChunksFileGroups: true,
	excludeHeadersInVectorization: true,
};
