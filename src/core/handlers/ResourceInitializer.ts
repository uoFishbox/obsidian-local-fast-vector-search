import { App, Notice } from "obsidian";
import { LoggerService } from "../../shared/services/LoggerService";
import { TextChunker } from "../chunking/TextChunker";
import { VectorizationService } from "../services/VectorizationService";
import { SearchService } from "../services/SearchService";
import { StorageManagementService } from "../services/StorageManagementService";
import { NotificationService } from "../../shared/services/NotificationService";
import { IntegratedWorkerProxy } from "../workers/IntegratedWorkerProxy";
import { NoteVectorService } from "../services/NoteVectorService";
import { CommandHandler } from "../../commands";
import type { PluginSettings } from "../../pluginSettings";
import type MyVectorPlugin from "../../main";

export class ResourceInitializer {
	private initializationPromise: Promise<void> | null = null;

	// Service instances
	textChunker: TextChunker | null = null;
	proxy: IntegratedWorkerProxy | null = null;
	vectorizationService: VectorizationService | null = null;
	searchService: SearchService | null = null;
	storageManagementService: StorageManagementService | null = null;
	notificationService: NotificationService | null = null;
	noteVectorService: NoteVectorService | null = null;
	commandHandler: CommandHandler | null = null;

	constructor(
		private app: App,
		private logger: LoggerService | null,
		private settings: PluginSettings,
		private plugin: MyVectorPlugin
	) {}

	async ensureResourcesInitialized(): Promise<void> {
		if (
			this.vectorizationService &&
			this.searchService &&
			this.storageManagementService &&
			this.commandHandler &&
			this.proxy
		) {
			this.logger?.verbose_log(
				"Resources already confirmed initialized."
			);
			return;
		}

		if (!this.initializationPromise) {
			this.logger?.verbose_log(
				"Initialization not started, starting now."
			);
			this.initializationPromise = this.initializeResources().catch(
				(error) => {
					this.initializationPromise = null;
					throw error;
				}
			);
		}

		this.logger?.verbose_log(
			"Waiting for resource initialization to complete..."
		);
		await this.initializationPromise;
		if (
			!this.vectorizationService ||
			!this.searchService ||
			!this.storageManagementService ||
			!this.commandHandler ||
			!this.proxy
		) {
			const errorMsg = "Resources failed to initialize after waiting.";
			this.logger?.error(errorMsg);
			throw new Error(errorMsg);
		}
		this.logger?.verbose_log("Resource initialization confirmed.");
	}

	async initializeResources(): Promise<void> {
		if (
			this.vectorizationService &&
			this.searchService &&
			this.storageManagementService &&
			this.commandHandler &&
			this.proxy
		) {
			this.logger?.verbose_log("Resources already initialized.");
			return;
		}

		if (this.settings.initializationDelay > 0) {
			this.logger?.log(
				`Delaying resource initialization by ${this.settings.initializationDelay}ms as configured.`
			);
			await new Promise((resolve) =>
				setTimeout(resolve, this.settings.initializationDelay)
			);
			this.logger?.verbose_log("Initialization delay finished.");
		}

		this.logger?.verbose_log(
			"Initializing resources (Integrated Worker, Services, Command Handler)..."
		);
		const initNotice = new Notice("Initializing resources...");

		try {
			// 0. Initialize IntegratedWorkerProxy first
			if (!this.proxy) {
				this.proxy = new IntegratedWorkerProxy(this.logger);
				this.logger?.verbose_log("IntegratedWorkerProxy created.");
			}
			initNotice.setMessage("Initializing integrated worker...");
			await this.proxy.ensureInitialized();
			this.logger?.verbose_log("IntegratedWorkerProxy initialized.");

			// 1. Initialize TextChunker
			if (!this.textChunker) {
				this.textChunker = new TextChunker();
				this.logger?.verbose_log("TextChunker initialized.");
			}

			// 2. Initialize Services
			if (!this.proxy)
				throw new Error("Worker proxy is null after creation attempt.");

			if (!this.vectorizationService) {
				this.vectorizationService = new VectorizationService(
					this.app,
					this.proxy,
					this.textChunker,
					this.logger,
					this.settings
				);
				this.logger?.verbose_log("VectorizationService initialized.");
			}
			if (!this.searchService) {
				this.searchService = new SearchService(this.proxy);
				this.logger?.verbose_log("SearchService initialized.");
			}
			if (!this.storageManagementService) {
				this.storageManagementService = new StorageManagementService(
					this.proxy,
					this.logger
				);
				this.logger?.verbose_log(
					"StorageManagementService initialized."
				);
			}
			if (!this.notificationService) {
				this.notificationService = new NotificationService();
				this.logger?.verbose_log("NotificationService initialized.");
			}

			// 3. Initialize CommandHandler
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
					this.storageManagementService,
					this.notificationService,
					this.plugin
				);
				this.logger?.verbose_log(
					"CommandHandler initialized with new services."
				);
			}

			if (
				!this.textChunker ||
				!this.vectorizationService ||
				!this.searchService ||
				!this.storageManagementService ||
				!this.commandHandler ||
				!this.proxy
			) {
				throw new Error(
					"Not all resources were ready after initialization attempt."
				);
			}

			// 4. Initialize NoteVectorService
			this.initializeNoteVectorService();

			initNotice.setMessage("Resources initialized successfully!");
			setTimeout(() => initNotice.hide(), 2000);
		} catch (error: any) {
			this.logger?.error("Failed to initialize resources:", error);
			initNotice.setMessage(
				`Resource initialization failed: ${error.message}`
			);
			setTimeout(() => initNotice.hide(), 5000);
			this.resetAllResources();
			throw error;
		} finally {
			this.logger?.verbose_log(
				"Resource initialization attempt finished."
			);
		}
	}

	private initializeNoteVectorService(): void {
		if (
			this.textChunker &&
			this.proxy &&
			this.logger &&
			!this.noteVectorService
		) {
			this.noteVectorService = new NoteVectorService(
				this.app,
				this.textChunker,
				this.proxy,
				this.logger,
				this.settings
			);
			this.logger.verbose_log("NoteVectorService initialized.");
		}
	}

	resetAllResources(): void {
		this.commandHandler = null;
		this.textChunker = null;
		this.vectorizationService = null;
		this.searchService = null;
		this.storageManagementService = null;
		if (this.proxy) {
			this.proxy.terminate();
			this.proxy = null;
		}
		this.noteVectorService = null;
		this.initializationPromise = null;
	}

	terminate(): void {
		this.resetAllResources();
	}
}
