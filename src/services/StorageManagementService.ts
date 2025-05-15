import type { PGliteVectorStore } from "../storage/PGliteVectorStore";

export class StorageManagementService {
	constructor(private vectorStore: PGliteVectorStore) {}

	public async rebuildStorage(
		onProgress?: (message: string) => void
	): Promise<void> {
		try {
			if (onProgress)
				onProgress(
					"Rebuilding storage: Closing provider connection..."
				);
			await this.vectorStore.getProvider().close();

			if (onProgress)
				onProgress(
					"Rebuilding storage: Deleting existing database file..."
				);
			await this.vectorStore.getProvider().discardDB();

			if (onProgress)
				onProgress("Rebuilding storage: Re-initializing provider...");
			await this.vectorStore.getProvider().initialize();

			if (onProgress)
				onProgress(
					"Rebuilding storage: Creating new embeddings table..."
				);
			// The DB is new, so force=false is appropriate. createTable handles schema/extensions.
			await this.vectorStore.createTable(false);

			if (onProgress) onProgress("Storage rebuild complete.");
			console.log(
				"Storage rebuild completed by StorageManagementService."
			);
		} catch (error) {
			console.error(
				"Failed to rebuild storage in StorageManagementService:",
				error
			);
			throw error; // Propagate error to CommandHandler
		}
	}
}
