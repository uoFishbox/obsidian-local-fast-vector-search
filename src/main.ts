// src/main.ts
import { Plugin, Notice, App, PluginSettingTab, Setting } from "obsidian";
import { IVectorizer } from "./vectorizers/IVectorizer";
import { createTransformersVectorizer } from "./vectorizers/VectorizerFactory";
import { CommandHandler } from "./commands";
import { WorkerProxyVectorizer } from "./vectorizers/WorkerProxyVectorizer";
import { PGliteProvider } from "./storage/PGliteProvider";
import { PGliteVectorStore } from "./storage/PGliteVectorStore";
import { SearchModal } from "./ui/SearchModal";
const EMBEDDING_DIMENSION = 512;

interface PluginSettings {
	provider: string;
	databaseName: string;
}

const DEFAULT_SETTINGS: PluginSettings = {
	provider: "transformer",
	databaseName: "embeddings",
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
			this.commandHandler &&
			this.vectorStore
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
				this.pgProvider = new PGliteProvider(
					this,
					this.settings.databaseName,
					true
				);
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
					await this.vectorStore.save();
				}
				this.isDbReady = true;
				console.log(
					"PGliteVectorStore initialized and table checked/created."
				);
			}

			// 3. CommandHandler の初期化
			if (
				this.isWorkerReady &&
				this.isDbReady &&
				this.vectorizer &&
				this.vectorStore &&
				!this.commandHandler
			) {
				this.commandHandler = new CommandHandler(
					this.app,
					this.vectorizer,
					this.vectorStore
				);
				console.log("CommandHandler initialized.");
			}

			if (
				!this.isWorkerReady ||
				!this.isDbReady ||
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
			.setName("Database Name")
			.setDesc(
				'The name of the database file to use (e.g., "my_embeddings"). Requires reload.'
			)
			.addText((text) =>
				text
					.setPlaceholder("Enter database name")
					.setValue(this.plugin.settings.databaseName)
					.onChange(async (value) => {
						this.plugin.settings.databaseName = value;
						await this.plugin.saveSettings();
						new Notice(
							"Database name changed. Please reload the plugin for changes to take effect."
						);
					})
			);
	}
}
