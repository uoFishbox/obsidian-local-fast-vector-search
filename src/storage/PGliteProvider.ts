import { Plugin, normalizePath } from "obsidian";
import { PGlite } from "@electric-sql/pglite";
import { pgliteResources } from "../database/modules/pglite-resources";

export class PGliteProvider {
	private plugin: Plugin;
	private dbName: string;
	private pgClient: PGlite | null = null;
	private isInitialized: boolean = false;
	private dbPath: string;
	private relaxedDurability: boolean;

	constructor(
		plugin: Plugin,
		dbName: string,
		relaxedDurability: boolean = true
	) {
		this.plugin = plugin;
		this.dbName = dbName;
		this.relaxedDurability = relaxedDurability;

		this.dbPath = normalizePath(
			`${this.plugin.manifest.dir}/${this.dbName}.db`
		);
		console.log("Database path set to:", this.dbPath);
	}

	async initialize(): Promise<void> {
		try {
			const { fsBundle, wasmModule, vectorExtensionBundlePath } =
				await this.loadPGliteResources();

			// Check if we have a saved database file
			const databaseFileExists =
				await this.plugin.app.vault.adapter.exists(this.dbPath);

			if (databaseFileExists) {
				// Load existing database
				console.log("Loading existing database from:", this.dbPath);
				const fileBuffer =
					await this.plugin.app.vault.adapter.readBinary(this.dbPath);
				const fileBlob = new Blob([fileBuffer], {
					type: "application/x-gzip",
				});

				// Create PGlite instance with existing data
				this.pgClient = await this.createPGliteInstance({
					loadDataDir: fileBlob,
					fsBundle,
					wasmModule,
					vectorExtensionBundlePath,
				});
			} else {
				// Create new database
				console.log("Creating new database");
				this.pgClient = await this.createPGliteInstance({
					fsBundle,
					wasmModule,
					vectorExtensionBundlePath,
				});
			}

			this.isInitialized = true;
			console.log("PGlite initialized successfully");

			// Make sure the directory exists
			const dirPath = this.dbPath.substring(
				0,
				this.dbPath.lastIndexOf("/")
			);
			if (!(await this.plugin.app.vault.adapter.exists(dirPath))) {
				await this.plugin.app.vault.adapter.mkdir(dirPath);
			}
		} catch (error) {
			console.error("Error initializing PGlite:", error);
			throw new Error(`Failed to initialize PGlite: ${error}`);
		}
	}

	getClient(): PGlite {
		if (!this.pgClient) {
			throw new Error("PGlite client is not initialized");
		}
		return this.pgClient;
	}

	isReady(): boolean {
		return this.isInitialized && this.pgClient !== null;
	}

	async save(): Promise<void> {
		if (!this.pgClient || !this.isInitialized) {
			console.log("Cannot save: PGlite not initialized");
			return;
		}

		try {
			console.log("Saving database to:", this.dbPath);
			const blob: Blob = await this.pgClient.dumpDataDir("gzip");
			await this.plugin.app.vault.adapter.writeBinary(
				this.dbPath,
				Buffer.from(await blob.arrayBuffer())
			);
			console.log("Database saved successfully");
		} catch (error) {
			console.error("Error saving database:", error);
			throw error;
		}
	}

	async close(): Promise<void> {
		if (this.pgClient) {
			try {
				// Save before closing
				await this.save();

				// Close the connection
				await this.pgClient.close();
				this.pgClient = null;
				this.isInitialized = false;
				console.log("PGlite connection closed");
			} catch (error) {
				console.error("Error closing PGlite connection:", error);
			}
		}
	}

	async deleteDatabaseFile(): Promise<void> {
		if (await this.plugin.app.vault.adapter.exists(this.dbPath)) {
			try {
				await this.plugin.app.vault.adapter.remove(this.dbPath);
				console.log(`Database file deleted: ${this.dbPath}`);
				// Reset initialization status as the DB file is gone
				this.isInitialized = false;
				this.pgClient = null;
			} catch (error) {
				console.error(
					`Error deleting database file ${this.dbPath}:`,
					error
				);
				throw error;
			}
		} else {
			console.log(
				`Database file not found, no need to delete: ${this.dbPath}`
			);
		}
	}

	private async createPGliteInstance(options: {
		loadDataDir?: Blob;
		fsBundle: Blob;
		wasmModule: WebAssembly.Module;
		vectorExtensionBundlePath: URL;
	}): Promise<PGlite> {
		// Create PGlite instance with options
		return await PGlite.create({
			...options,
			relaxedDurability: this.relaxedDurability,
			fsBundle: options.fsBundle,
			wasmModule: options.wasmModule,
			extensions: {
				vector: options.vectorExtensionBundlePath,
			},
		});
	}

	private async loadPGliteResources(): Promise<{
		fsBundle: Blob;
		wasmModule: WebAssembly.Module;
		vectorExtensionBundlePath: URL;
	}> {
		try {
			// Convert base64 to binary data
			const wasmBinary = Buffer.from(
				pgliteResources.wasmBase64,
				"base64"
			);
			const dataBinary = Buffer.from(
				pgliteResources.dataBase64,
				"base64"
			);
			const vectorBinary = Buffer.from(
				pgliteResources.vectorBase64,
				"base64"
			);

			// Create blobs from binary data
			const fsBundle = new Blob([dataBinary], {
				type: "application/octet-stream",
			});
			const wasmModule = await WebAssembly.compile(wasmBinary);

			// Create a blob URL for the vector extension
			const vectorBlob = new Blob([vectorBinary], {
				type: "application/gzip",
			});
			const vectorExtensionBundlePath = URL.createObjectURL(vectorBlob);
			return {
				fsBundle,
				wasmModule,
				vectorExtensionBundlePath: new URL(vectorExtensionBundlePath),
			};
		} catch (error) {
			console.error("Error loading PGlite resources:", error);
			throw error;
		}
	}
}
