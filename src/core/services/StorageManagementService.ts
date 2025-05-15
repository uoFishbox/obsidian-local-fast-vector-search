import type { PGliteProvider } from "../storage/pglite/PGliteProvider";
import type { PGliteTableManager } from "../storage/pglite/PGliteTableManager";

export class StorageManagementService {
	constructor(
		private provider: PGliteProvider,
		private tableManager: PGliteTableManager
	) {}

	public async rebuildStorage(
		onProgress?: (message: string) => void
	): Promise<void> {
		try {
			if (onProgress)
				onProgress(
					"Rebuilding storage: Closing provider connection..."
				);
			await this.provider.close();

			if (onProgress)
				onProgress(
					"Rebuilding storage: Deleting existing database file..."
				);
			await this.provider.discardDB();

			if (onProgress)
				onProgress("Rebuilding storage: Re-initializing provider...");
			await this.provider.initialize();

			if (onProgress)
				onProgress(
					"Rebuilding storage: Creating new embeddings table..."
				);
			// The DB is new, so force=false is appropriate. createTable handles schema/extensions.
			await this.tableManager.createTable(false);

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
