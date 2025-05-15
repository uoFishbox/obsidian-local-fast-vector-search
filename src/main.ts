import {
	Plugin,
	Notice,
	App,
	PluginSettingTab,
	Setting,
	Modal,
} from "obsidian";
import { IVectorizer } from "./vectorizers/IVectorizer";
import { createTransformersVectorizer } from "./vectorizers/VectorizerFactory";
import { CommandHandler } from "./commands";
import { WorkerProxyVectorizer } from "./vectorizers/WorkerProxyVectorizer";
import { PGliteProvider } from "./storage/PGliteProvider";
import { PGliteVectorStore } from "./storage/PGliteVectorStore";
import { SearchModal } from "./ui/SearchModal";
import { DB_NAME } from "./shared/constants/appConstants";
import { TextChunker } from "./chunkers/TextChunker";
import { VectorizationService } from "./services/VectorizationService";
import { SearchService } from "./services/SearchService";
import { StorageManagementService } from "./services/StorageManagementService";
const EMBEDDING_DIMENSION = 256;

interface PluginSettings {
	provider: string;
}

const DEFAULT_SETTINGS: PluginSettings = {
	provider: "transformer",
};

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
	textChunker: TextChunker | null = null; // TextChunkerもここで初期化

	async onload() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);

		this.addSettingTab(new VectorizerSettingTab(this.app, this));

		this.app.workspace.onLayoutReady(async () => {
			console.log(
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

				new SearchModal(this.app, this.commandHandler).open();
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
			console.log("Initialization not started, starting now.");
			this.initializationPromise = this.initializeResources();
		}

		console.log("Waiting for resource initialization to complete...");
		await this.initializationPromise;
		if (!this.isWorkerReady || !this.isDbReady) {
			throw new Error("Resources failed to initialize.");
		}
		console.log("Resource initialization confirmed.");
	}

	async initializeResources(): Promise<void> {
		if (this.isWorkerReady && this.isDbReady) {
			console.log("Resources already initialized.");
			return;
		}

		console.log(
			"Initializing resources (Vectorizer, Database, Command Handler)..."
		);
		const initNotice = new Notice("Initializing resources...", 0);

		try {
			// 1. Vectorizer (Worker) の初期化
			if (!this.isWorkerReady) {
				initNotice.setMessage("Initializing vectorizer worker...");
				this.vectorizer = createTransformersVectorizer();
				if (this.vectorizer instanceof WorkerProxyVectorizer) {
					console.log(
						"Waiting for WorkerProxyVectorizer initialization..."
					);
					await this.vectorizer.ensureInitialized();
					this.isWorkerReady = true;
					console.log("Vectorizer Worker is ready.");
				} else {
					this.isWorkerReady = true;
				}
			}

			// 2. PGliteProvider と PGliteVectorStore の初期化
			if (!this.isDbReady && this.isWorkerReady) {
				initNotice.setMessage("Initializing database...");
				this.pgProvider = new PGliteProvider(this, DB_NAME, true);
				await this.pgProvider.initialize();
				console.log("PGliteProvider initialized.");

				this.vectorStore = new PGliteVectorStore(
					this.pgProvider,
					EMBEDDING_DIMENSION
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
				console.log(
					"PGliteVectorStore initialized and table checked/created."
				);
			}

			// 3. Initialize TextChunker
			if (!this.textChunker) {
				this.textChunker = new TextChunker({}); // Use default options or load from settings
				console.log("TextChunker initialized.");
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
						this.textChunker
					);
					console.log("VectorizationService initialized.");
				}
				if (!this.searchService) {
					this.searchService = new SearchService(
						this.vectorizer,
						this.vectorStore
					);
					console.log("SearchService initialized.");
				}
				if (!this.storageManagementService) {
					this.storageManagementService =
						new StorageManagementService(this.vectorStore);
					console.log("StorageManagementService initialized.");
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
				console.log("CommandHandler initialized with new services.");
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
			console.error("Failed to initialize resources:", error);
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
			console.log("Resource initialization attempt finished.");
		}
	}

	async onunload() {
		console.log("Unloading vector plugin...");
		if (this.vectorizer instanceof WorkerProxyVectorizer) {
			console.log("Terminating vectorizer worker...");
			this.vectorizer.terminate();
		}
		if (this.pgProvider) {
			console.log("Closing PGlite database connection...");
			await this.pgProvider
				.close()
				.catch((err) => console.error("Error closing PGlite:", err));
		}

		this.vectorizer = null;
		this.commandHandler = null;
		this.pgProvider = null;
		this.vectorStore = null;
		this.textChunker = null;
		this.vectorizationService = null;
		this.searchService = null;
		this.storageManagementService = null;
		this.initializationPromise = null;
		this.isWorkerReady = false;
		this.isDbReady = false;
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class VectorizerSettingTab extends PluginSettingTab {
	plugin: MyVectorPlugin;

	constructor(app: App, plugin: MyVectorPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl("h2", { text: "Vectorizer Settings" });

		new Setting(containerEl)
			.setName("Provider")
			.setDesc(
				"Select the vectorizer provider (Requires restart or reload after change)"
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOption("transformers", "Transformers.js (in Obsidian)")
					.setValue(this.plugin.settings.provider)
					.onChange(async (value) => {
						this.plugin.settings.provider = value;
						await this.plugin.saveSettings();
						new Notice(
							"Provider changed. Please reload the plugin for changes to take effect."
						);
					})
			);

		new Setting(containerEl)
			.setName("Discard Database")
			.setDesc("Permanently delete the PGlite database.")
			.addButton((button) =>
				button
					.setButtonText("Discard DB")
					.setCta()
					.onClick(() => {
						new DiscardDBModal(this.app, this.plugin).open();
					})
			);
	}
}

class DiscardDBModal extends Modal {
	plugin: MyVectorPlugin;

	constructor(app: App, plugin: MyVectorPlugin) {
		super(app);
		this.plugin = plugin;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl("h2", { text: "Discard Database" });
		contentEl.createEl("p", {
			text: "Are you sure you want to permanently discard the PGlite database? This action cannot be undone.",
		});

		new Setting(contentEl)
			.addButton((button) =>
				button
					.setButtonText("Discard")
					.setCta()
					.onClick(async () => {
						try {
							if (this.plugin.pgProvider) {
								await this.plugin.pgProvider.discardDB();
								new Notice("Database discarded successfully.");
							} else {
								new Notice(
									"Database provider not initialized."
								);
							}
						} catch (error: any) {
							console.error("Failed to discard database:", error);
							new Notice(
								`Failed to discard database: ${error.message}`
							);
						} finally {
							this.close();
						}
					})
			)
			.addButton((button) =>
				button.setButtonText("Cancel").onClick(() => {
					this.close();
				})
			);
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}
