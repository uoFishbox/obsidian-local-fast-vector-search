import {
	Plugin,
	Notice,
	TFile,
	TAbstractFile,
	type CachedMetadata,
	debounce,
} from "obsidian";
import { LoggerService } from "./shared/services/LoggerService";
import { deleteDB } from "idb";
import { DB_NAME } from "./shared/constants/appConstants";
import {
	RelatedChunksView,
	VIEW_TYPE_RELATED_CHUNKS,
} from "./ui/sidebar/RelatedChunksView";
import { type PluginSettings, DEFAULT_SETTINGS } from "./pluginSettings";
import { VectorizerSettingTab } from "./ui/settings";
import { FileEventHandler } from "./core/handlers/FileEventHandler";
import { ResourceInitializer } from "./core/handlers/ResourceInitializer";
import { ViewManager } from "./core/handlers/ViewManager";
import { CommandRegistrar } from "./core/handlers/CommandRegistrar";
import { InitialRebuildModal } from "./ui/modals/InitialRebuildModal";

export default class MyVectorPlugin extends Plugin {
	settings: PluginSettings = DEFAULT_SETTINGS;
	logger: LoggerService | null = null;

	// Handler instances
	private resourceInitializer!: ResourceInitializer;
	private fileEventHandler!: FileEventHandler;
	private viewManager!: ViewManager;
	public commandRegistrar!: CommandRegistrar;
	private debouncedHandleActiveLeafChange!: () => void;

	async onload() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
		this.logger = new LoggerService();
		this.logger.updateSettings(this.settings);
		this.addSettingTab(new VectorizerSettingTab(this.app, this));

		// Initialize handlers
		this.resourceInitializer = new ResourceInitializer(
			this.app,
			this.logger,
			this.settings,
			this
		);

		this.viewManager = new ViewManager(
			this.app,
			this.logger,
			this.settings,
			() => this.resourceInitializer.noteVectorService,
			this.resourceInitializer.notificationService
		);

		this.fileEventHandler = new FileEventHandler(
			this.app,
			this.logger,
			() => this.resourceInitializer.vectorizationService,
			async () => {
				this.viewManager.resetLastProcessedFile();
				await this.viewManager.handleActiveLeafChange();
			}
		);

		this.commandRegistrar = new CommandRegistrar(
			this.app,
			this,
			this.logger,
			this.settings,
			this.resourceInitializer,
			this.viewManager,
			this.clearResources.bind(this)
		);

		this.debouncedHandleActiveLeafChange = debounce(
			this.viewManager.handleActiveLeafChange.bind(this.viewManager),
			100,
			true
		);

		this.app.workspace.onLayoutReady(async () => {
			this.logger?.verbose_log(
				"Obsidian layout ready. Triggering background initialization."
			);

			try {
				const rebuildFlag = sessionStorage.getItem(
					"my-vector-plugin-rebuild-flag"
				);
				// 初回起動チェック: rebuildFlagが無く、かつDBが存在しない場合
				if (!rebuildFlag) {
					const dbExists = await this.checkDbExists();
					if (!dbExists) {
						this.logger?.log(
							"Database not found. Proposing initial index rebuild."
						);
						new InitialRebuildModal(this.app, () => {
							this.commandRegistrar.rebuildAllIndexes();
						}).open();
						return; // ユーザーのアクションを待つため、ここで処理を終了
					}
				}

				if (rebuildFlag === "true") {
					sessionStorage.removeItem("my-vector-plugin-rebuild-flag");

					await this.resourceInitializer.ensureResourcesInitialized();

					if (this.resourceInitializer.commandHandler) {
						new Notice(
							"Resources initialized. Starting index rebuild...",
							3000
						);
						await this.resourceInitializer.commandHandler.rebuildAllIndexes();

						this.logger?.log("Index rebuild complete.");
						this.viewManager.resetLastProcessedFile();
					} else {
						const errorMsg =
							"Could not start rebuild: Command handler is not ready.";
						new Notice(errorMsg, 7000);
						this.logger?.error(errorMsg);
					}
				} else {
					// Normal background initialization when not rebuilding
					try {
						await this.resourceInitializer.initializeResources();
					} catch (error) {
						console.error(
							"Background resource initialization failed:",
							error
						);
						new Notice(
							"Failed to initialize resources. Check console."
						);
					}
				}
			} catch (error) {
				const errorMsg =
					"An error occurred during post-reload rebuild action. Check console.";
				console.error(errorMsg, error);
				new Notice(errorMsg, 7000);
				sessionStorage.removeItem("my-vector-plugin-rebuild-flag");
			}

			if (this.settings.autoShowRelatedChunksSidebar) {
				this.viewManager.activateRelatedChunksView();
			}
			this.registerEvent(
				this.app.workspace.on(
					"active-leaf-change",
					this.debouncedHandleActiveLeafChange
				)
			);
			this.viewManager.handleActiveLeafChange();
		});

		this.registerEvent(
			this.app.metadataCache.on(
				"changed",
				this.fileEventHandler.handleFileChange.bind(
					this.fileEventHandler
				)
			)
		);
		this.registerEvent(
			this.app.metadataCache.on(
				"deleted",
				this.fileEventHandler.handleFileDelete.bind(
					this.fileEventHandler
				)
			)
		);
		this.registerEvent(
			this.app.vault.on(
				"rename",
				this.fileEventHandler.handleFileRename.bind(
					this.fileEventHandler
				)
			)
		);

		this.registerView(
			VIEW_TYPE_RELATED_CHUNKS,
			(leaf) => new RelatedChunksView(leaf, this)
		);

		this.commandRegistrar.registerAllCommands();
	}

	async onunload() {
		this.logger?.verbose_log("Unloading vector plugin...");
		this.app.workspace.detachLeavesOfType(VIEW_TYPE_RELATED_CHUNKS);

		this.fileEventHandler.clearAllTimers();
		this.resourceInitializer.terminate();
		this.viewManager.resetLastProcessedFile();

		this.logger = null;
	}

	async saveSettings() {
		await this.saveData(this.settings);
		if (this.logger) {
			this.logger.updateSettings(this.settings);
		}
	}

	async rebuildAllIndexes(): Promise<void> {
		await this.resourceInitializer.ensureResourcesInitialized();
		if (this.resourceInitializer.commandHandler) {
			await this.resourceInitializer.commandHandler.rebuildAllIndexes();
		} else {
			throw new Error("Command handler not ready.");
		}
	}

	async clearResources(discardDbOnly: boolean): Promise<void> {
		this.logger?.log(
			`Attempting to delete resources (discardDbOnly: ${discardDbOnly})...`
		);

		this.fileEventHandler.clearAllTimers();

		if (this.resourceInitializer.proxy) {
			try {
				await this.resourceInitializer.proxy.closeDatabase();
				this.logger?.verbose_log("PGlite database closed via worker.");
			} catch (e) {
				this.logger?.warn(
					"Failed to gracefully close DB via worker, proceeding with termination.",
					e
				);
			}
			this.resourceInitializer.resetAllResources();
			this.logger?.verbose_log(
				"IntegratedWorkerProxy terminated and plugin services reset."
			);
		}

		await deleteDB("/pglite/" + DB_NAME);
		this.logger?.verbose_log(
			"PGlite database files deleted from IndexedDB."
		);

		if (!discardDbOnly) {
			const cacheNamePatterns = [
				/^transformers-cache$/i,
				/^huggingface-hub$/i,
			];
			let clearedSomething = false;

			const cacheKeys = await caches.keys();
			for (const key of cacheKeys) {
				if (cacheNamePatterns.some((pattern) => pattern.test(key))) {
					await caches.delete(key);
					this.logger?.verbose_log(`Cache '${key}' deleted.`);
					clearedSomething = true;
				}
			}

			await deleteDB("pglite-resources-cache");
			this.logger?.verbose_log(
				"PGlite resource cache deleted from IndexedDB."
			);

			if (!clearedSomething) {
				this.logger?.verbose_log("No matching caches found to clear.");
			}
		}

		const message = discardDbOnly
			? "Database discarded."
			: "All resources deleted.";
		new Notice(message);
	}

	private async checkDbExists(): Promise<boolean> {
		try {
			if (!("indexedDB" in window)) {
				this.logger?.warn(
					"IndexedDB is not supported in this environment."
				);
				return false;
			}
			const dbs = await indexedDB.databases();
			return dbs.some((db) => db.name === `/pglite/${DB_NAME}`);
		} catch (error) {
			this.logger?.error(
				"Failed to check for IndexedDB existence:",
				error
			);
			return false;
		}
	}
}
