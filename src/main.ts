import { Plugin, Notice, App } from "obsidian";
import { LoggerService } from "./shared/services/LoggerService";
import { IVectorizer } from "./core/vectorizers/IVectorizer";
import { createTransformersVectorizer } from "./core/vectorizers/VectorizerFactory";
import { CommandHandler } from "./commands";
import { WorkerProxyVectorizer } from "./core/vectorizers/WorkerVectorizerProxy";
import { PGliteProvider } from "./core/storage/pglite/PGliteProvider";
import { PGliteVectorStore } from "./core/storage/pglite/PGliteVectorStore";
import { SearchModal } from "./ui/modals/SearchModal";
import { DB_NAME } from "./shared/constants/appConstants";
import { TextChunker } from "./core/chunking/TextChunker";
import { NotificationService } from "./shared/services/NotificationService";
import { VectorizationService } from "./core/services/VectorizationService";
import { SearchService } from "./core/services/SearchService";
import { StorageManagementService } from "./core/services/StorageManagementService";
import { PGliteTableManager } from "./core/storage/pglite/PGliteTableManager";

const EMBEDDING_DIMENSION = 256;

import { PluginSettings, DEFAULT_SETTINGS } from "./pluginSettings";
import { VectorizerSettingTab } from "./ui/settings";

export default class MyVectorPlugin extends Plugin {
	settings: PluginSettings = DEFAULT_SETTINGS;
	private initializationPromise: Promise<void> | null = null;
	vectorizer: IVectorizer | null = null;
	commandHandler: CommandHandler | null = null;
	private isWorkerReady = false;

	pgProvider: PGliteProvider | null = null;
	vectorStore: PGliteVectorStore | null = null;
	private isDbReady = false;

	// Service instances
	vectorizationService: VectorizationService | null = null;
	searchService: SearchService | null = null;
	storageManagementService: StorageManagementService | null = null;
	notificationService: NotificationService | null = null;
	textChunker: TextChunker | null = null;
	logger: LoggerService | null = null; // 型を修正し、初期値をnullに設定

	async onload() {
		this.logger = new LoggerService();
		this.logger.updateSettings(this.settings); // LoggerServiceの初期設定を反映
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);

		this.addSettingTab(new VectorizerSettingTab(this.app, this));

		this.app.workspace.onLayoutReady(async () => {
			if (this.logger)
				this.logger.verbose_log(
					"Obsidian layout ready. Triggering background initialization."
				);
			this.initializationPromise = this.initializeResources().catch(
				(error) => {
					console.error(
						"Background resource initialization failed:",
						error
					);
					new Notice(
						"Failed to initialize resources. Check console."
					);
					this.isWorkerReady = false;
					this.isDbReady = false;
				}
			);
		});

		this.addCommand({
			id: "vectorize-all-notes",
			name: "Vectorize all notes (Worker & Save)",
			callback: async () => {
				try {
					await this.ensureResourcesInitialized();
				} catch (error) {
					console.error(
						"Resource initialization check failed:",
						error
					);
					new Notice("Resources are not ready. Check console.");
					return;
				}
				if (!this.commandHandler) {
					new Notice("Command handler not ready.");
					return;
				}
				await this.commandHandler.vectorizeAllNotes();
			},
		});

		this.addCommand({
			id: "search-similar-notes",
			name: "Search similar notes",
			callback: async () => {
				try {
					await this.ensureResourcesInitialized();
				} catch (error) {
					console.error(
						"Resource initialization check failed for search:",
						error
					);
					new Notice(
						"Resources are not ready for search. Check console."
					);
					return;
				}
				if (!this.commandHandler) {
					new Notice(
						"Command handler not ready for search. Please try reloading the plugin."
					);
					return;
				}

				if (!this.notificationService) {
					new Notice("Notification service not ready.");
					return;
				}
				new SearchModal(
					this.app,
					this.commandHandler,
					this.notificationService
				).open();
			},
		});

		this.addCommand({
			id: "rebuild-all-indexes",
			name: "Rebuild all indexes (Clear and re-vectorize all notes)",
			callback: async () => {
				try {
					await this.ensureResourcesInitialized();
				} catch (error) {
					console.error(
						"Resource initialization check failed for rebuild:",
						error
					);
					new Notice(
						"Resources are not ready for rebuild. Check console."
					);
					return;
				}
				if (!this.commandHandler) {
					new Notice(
						"Command handler not ready for rebuild. Please try reloading the plugin."
					);
					return;
				}

				await this.commandHandler.rebuildAllIndexes();
			},
		});
	}

	async ensureResourcesInitialized(): Promise<void> {
		if (
			this.isWorkerReady &&
			this.isDbReady &&
			this.vectorizer &&
			this.vectorStore &&
			this.textChunker &&
			this.vectorizationService &&
			this.searchService &&
			this.storageManagementService &&
			this.commandHandler
		) {
			return;
		}

		if (!this.initializationPromise) {
			if (this.logger)
				this.logger.verbose_log(
					"Initialization not started, starting now."
				);
			this.initializationPromise = this.initializeResources();
		}

		if (this.logger)
			this.logger.verbose_log(
				"Waiting for resource initialization to complete..."
			);
		await this.initializationPromise;
		if (!this.isWorkerReady || !this.isDbReady) {
			throw new Error("Resources failed to initialize.");
		}
		if (this.logger)
			this.logger.verbose_log("Resource initialization confirmed.");
	}

	async initializeResources(): Promise<void> {
		if (this.isWorkerReady && this.isDbReady) {
			if (this.logger)
				this.logger.verbose_log("Resources already initialized.");
			return;
		}

		if (this.logger)
			this.logger.verbose_log(
				"Initializing resources (Vectorizer, Database, Command Handler)..."
			);
		const initNotice = new Notice("Initializing resources...", 0);

		try {
			// 1. Vectorizer (Worker) の初期化
			if (!this.isWorkerReady) {
				initNotice.setMessage("Initializing vectorizer worker...");
				this.vectorizer = createTransformersVectorizer(this.logger); // loggerを渡す
				if (this.vectorizer instanceof WorkerProxyVectorizer) {
					if (this.logger)
						this.logger.verbose_log(
							"Waiting for WorkerProxyVectorizer initialization..."
						);
					await this.vectorizer.ensureInitialized();
					this.isWorkerReady = true;
					if (this.logger)
						this.logger.verbose_log("Vectorizer Worker is ready.");
				} else {
					this.isWorkerReady = true;
				}
			}

			// 2. PGliteProvider と PGliteVectorStore の初期化
			if (!this.isDbReady && this.isWorkerReady) {
				initNotice.setMessage("Initializing database...");
				this.pgProvider = new PGliteProvider(
					this,
					DB_NAME,
					true,
					this.logger
				); // loggerを渡す
				await this.pgProvider.initialize();
				if (this.logger)
					this.logger.verbose_log("PGliteProvider initialized.");

				this.vectorStore = new PGliteVectorStore(
					this.pgProvider,
					EMBEDDING_DIMENSION,
					undefined, // tableName はデフォルト値を使用
					this.logger // loggerを渡す
				);
				const tableInfo = await this.vectorStore.checkTableExists();
				if (
					!tableInfo.exists ||
					tableInfo.dimensions !== EMBEDDING_DIMENSION
				) {
					if (
						tableInfo.exists &&
						tableInfo.dimensions !== EMBEDDING_DIMENSION
					) {
						console.warn(
							`Vector table dimensions mismatch. Expected ${EMBEDDING_DIMENSION}, got ${tableInfo.dimensions}. Recreating table.`
						);
						new Notice(
							`Recreating vector table due to dimension mismatch. Existing vectors will be lost.`,
							5000
						);
					}
					await this.vectorStore.createTable(true);
				}
				this.isDbReady = true;
				if (this.logger)
					this.logger.verbose_log(
						"PGliteVectorStore initialized and table checked/created."
					);
			}

			// 3. Initialize TextChunker
			if (!this.textChunker) {
				this.textChunker = new TextChunker({}); // Use default options or load from settings
				if (this.logger)
					this.logger.verbose_log("TextChunker initialized.");
			}

			// 4. Initialize Services (after vectorizer, vectorStore, textChunker are ready)
			if (
				this.isWorkerReady &&
				this.isDbReady &&
				this.vectorizer &&
				this.vectorStore &&
				this.textChunker
			) {
				if (!this.vectorizationService) {
					this.vectorizationService = new VectorizationService(
						this.app,
						this.vectorizer,
						this.vectorStore,
						this.textChunker,
						this.logger // loggerを渡す
					);
					if (this.logger)
						this.logger.verbose_log(
							"VectorizationService initialized."
						);
				}
				if (!this.searchService) {
					this.searchService = new SearchService(
						this.vectorizer,
						this.vectorStore
					);
					if (this.logger)
						this.logger.verbose_log("SearchService initialized.");
				}
				if (!this.storageManagementService) {
					this.storageManagementService =
						new StorageManagementService(
							this.pgProvider!,
							new PGliteTableManager(
								this.pgProvider!,
								this.vectorStore!.getTableName(),
								this.vectorStore!.getDimensions(),
								this.logger // loggerを渡す
							),
							this.logger // loggerを渡す
						);
					if (this.logger)
						this.logger.verbose_log(
							"StorageManagementService initialized."
						);
				}
				if (!this.notificationService) {
					this.notificationService = new NotificationService();
					if (this.logger)
						this.logger.verbose_log(
							"NotificationService initialized."
						);
				}
			}

			// 5. CommandHandler の初期化 (after services are ready)
			if (
				this.vectorizationService &&
				this.searchService &&
				this.storageManagementService &&
				!this.commandHandler
			) {
				this.commandHandler = new CommandHandler(
					this.app,
					this.vectorizationService,
					this.searchService,
					this.storageManagementService
				);
				if (this.logger)
					this.logger.verbose_log(
						"CommandHandler initialized with new services."
					);
			}

			if (
				!this.isWorkerReady ||
				!this.isDbReady ||
				!this.textChunker ||
				!this.vectorizationService ||
				!this.searchService ||
				!this.storageManagementService ||
				!this.commandHandler
			) {
				throw new Error(
					"Not all resources were ready after initialization attempt."
				);
			}
			initNotice.setMessage("Resources initialized successfully!");
			setTimeout(() => initNotice.hide(), 2000);
		} catch (error: any) {
			if (this.logger)
				this.logger.error("Failed to initialize resources:", error);
			initNotice.setMessage(
				`Resource initialization failed: ${error.message}`
			);
			setTimeout(() => initNotice.hide(), 5000);
			this.isWorkerReady = false;
			this.isDbReady = false;
			this.vectorizer = null;
			this.pgProvider = null;
			this.vectorStore = null;
			this.commandHandler = null;
			this.textChunker = null;
			this.vectorizationService = null;
			this.searchService = null;
			this.storageManagementService = null;
			throw error;
		} finally {
			if (this.logger)
				this.logger.verbose_log(
					"Resource initialization attempt finished."
				);
		}
	}

	async onunload() {
		if (this.logger) this.logger.verbose_log("Unloading vector plugin...");
		if (this.vectorizer instanceof WorkerProxyVectorizer) {
			if (this.logger)
				this.logger.verbose_log("Terminating vectorizer worker...");
			this.vectorizer.terminate();
		}
		if (this.pgProvider) {
			if (this.logger)
				this.logger.verbose_log(
					"Closing PGlite database connection..."
				);
			await this.pgProvider.close().catch((err: any) => {
				// 波括弧を追加
				if (this.logger)
					this.logger.error("Error closing PGlite:", err);
			}); // 波括弧を追加
		}

		this.vectorizer = null;
		this.commandHandler = null;
		this.pgProvider = null;
		this.vectorStore = null;
		this.notificationService = null;
		this.textChunker = null;
		this.vectorizationService = null;
		this.searchService = null;
		this.storageManagementService = null;
		this.initializationPromise = null;
		this.isWorkerReady = false;
		this.isDbReady = false;
		this.logger = null;
	}

	async saveSettings() {
		await this.saveData(this.settings);
		if (this.logger) {
			// nullチェックを追加
			this.logger.updateSettings(this.settings);
		}
	}
}
