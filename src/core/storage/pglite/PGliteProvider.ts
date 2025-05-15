import { PGlite } from "@electric-sql/pglite";
import { deleteDB } from "idb";
import { LoggerService } from "../../../shared/services/LoggerService";
import { createAndInitDb, CreateDbOptions } from "./pgworker";

export class PGliteProvider {
	private dbName: string;
	private pgClient: PGlite | null = null;
	private isInitialized: boolean = false;
	private relaxedDurability: boolean;
	private logger: LoggerService | null;

	private tableName: string;
	private dimensions: number;

	constructor(
		dbName: string,
		relaxedDurability: boolean = true,
		logger: LoggerService | null,
		tableName: string,
		dimensions: number
	) {
		this.logger = logger;
		this.dbName = dbName;
		this.relaxedDurability = relaxedDurability;
		this.tableName = tableName;
		this.dimensions = dimensions;
		this.logger?.verbose_log(
			"PGliteProvider (Worker mode via pgworker) initialized."
		);
	}

	async initialize(): Promise<void> {
		if (this.isInitialized && this.pgClient) {
			this.logger?.verbose_log(
				"PGliteProvider (Worker) already initialized."
			);
			return;
		}

		try {
			this.logger?.verbose_log(
				`Initializing PGlite via pgworker for database: ${this.dbName}`
			);

			const workerOptions: CreateDbOptions = {
				dbName: this.dbName,
				tableName: this.tableName,
				dimensions: this.dimensions,
				relaxedDurability: this.relaxedDurability,
			};

			this.pgClient = await createAndInitDb(workerOptions);

			this.isInitialized = true;
			this.logger?.verbose_log(
				"PGlite (via Worker) initialized successfully"
			);
		} catch (error) {
			this.logger?.error(
				"Error initializing PGlite (via Worker):",
				error
			);

			this.pgClient = null;
			this.isInitialized = false;
			throw new Error(
				`Failed to initialize PGlite (via Worker): ${error}`
			);
		}
	}

	getClient(): PGlite {
		if (!this.pgClient) {
			const error = new Error(
				"PGlite client (Worker proxy) is not initialized"
			);
			this.logger?.error("PGlite client error:", error);
			throw error;
		}
		return this.pgClient;
	}

	isReady(): boolean {
		return this.isInitialized && this.pgClient !== null;
	}

	async close(): Promise<void> {
		if (this.pgClient) {
			try {
				await this.pgClient.close();
				this.logger?.verbose_log(
					"PGlite connection (in worker) closed"
				);
			} catch (error) {
				this.logger?.error(
					"Error closing PGlite connection (in worker):",
					error
				);
			}
		}
	}

	async discardDB(): Promise<void> {
		this.logger?.verbose_log(`Discarding PGlite database: ${this.dbName}.`);
		try {
			if (this.pgClient) {
				await this.close();
				this.logger?.verbose_log(
					"Closed PGlite connection in worker before discarding DB."
				);
			}

			await deleteDB("/pglite/" + this.dbName);
			this.logger?.verbose_log(
				`Successfully discarded database from IndexedDB: ${this.dbName}`
			);
		} catch (error: any) {
			this.logger?.error(
				`Error discarding PGlite database ${this.dbName}:`,
				error
			);
			const errorMessage = error?.message || "Unknown error";
			const errorDetails = error?.name ? `(${error.name})` : "";
			throw new Error(
				`Failed to discard PGlite database ${this.dbName}: ${errorMessage} ${errorDetails}`
			);
		} finally {
			// 状態をリセット
			this.pgClient = null;
			this.isInitialized = false;
		}
	}
}
