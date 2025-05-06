import { Plugin, Notice, App, PluginSettingTab, Setting } from "obsidian";
import { IVectorizer } from "./vectorizers/IVectorizer";
import { createTransformersVectorizer } from "./vectorizers/VectorizerFactory";
import { CommandHandler } from "./commands";
import { WorkerProxyVectorizer } from "./vectorizers/WorkerProxyVectorizer";

// --- PluginSettings Interface ---
interface PluginSettings {
	provider: string;
}

// --- Default Settings ---
const DEFAULT_SETTINGS: PluginSettings = {
	provider: "transformer",
};

export default class MyVectorPlugin extends Plugin {
	settings: PluginSettings = DEFAULT_SETTINGS;
	private initializationPromise: Promise<void> | null = null;
	vectorizer: IVectorizer | null = null;
	commandHandler: CommandHandler | null = null;
	private isWorkerReady = false;

	async onload() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);

		this.addSettingTab(new VectorizerSettingTab(this.app, this));

		// レイアウト準備完了後にバックグラウンドで初期化を開始
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
						"Failed to initialize vectorizer worker. Check console."
					);
					this.isWorkerReady = false;
				}
			);
		});

		this.addCommand({
			id: "vectorize-current-note",
			name: "Vectorize current note (Worker)",
			editorCallback: async (editor) => {
				try {
					await this.ensureWorkerInitialized();
				} catch (error) {
					console.error("Worker initialization check failed:", error);
					new Notice("Vectorizer is not ready. Check console.");
					return;
				}
				if (!this.commandHandler) {
					new Notice("Command handler not ready.");
					return;
				}
				await this.commandHandler.vectorizeCurrentNote(editor);
			},
		});

		this.addCommand({
			id: "vectorize-all-notes",
			name: "Vectorize all notes (Worker)",
			callback: async () => {
				try {
					await this.ensureWorkerInitialized();
				} catch (error) {
					console.error("Worker initialization check failed:", error);
					new Notice("Vectorizer is not ready. Check console.");
					return;
				}
				if (!this.commandHandler) {
					new Notice("Command handler not ready.");
					return;
				}
				await this.commandHandler.vectorizeAllNotes();
			},
		});
	}

	async ensureWorkerInitialized(): Promise<void> {
		if (this.isWorkerReady && this.vectorizer && this.commandHandler) {
			return;
		}

		if (!this.initializationPromise) {
			console.log("Initialization not started, starting now.");
			this.initializationPromise = this.initializeResources();
		}

		console.log("Waiting for vectorizer initialization to complete...");
		await this.initializationPromise;
		if (!this.isWorkerReady) {
			throw new Error("Vectorizer failed to initialize.");
		}
		console.log("Vectorizer initialization confirmed.");
	}
	async initializeResources(): Promise<void> {
		if (this.isWorkerReady) {
			console.log("Resources already initialized.");
			return;
		}

		console.log(
			"Initializing resources (Vectorizer and Command Handler)..."
		);
		new Notice("Initializing vectorizer...", 3000); // 少し長めに表示

		try {
			this.vectorizer = createTransformersVectorizer();

			if (this.vectorizer instanceof WorkerProxyVectorizer) {
				console.log(
					"Waiting for WorkerProxyVectorizer initialization..."
				);
				await this.vectorizer.ensureInitialized();
				this.isWorkerReady = true;
				console.log("Vectorizer Worker is ready.");
				new Notice("Vectorizer worker ready!", 2000);
			} else {
				console.warn(
					`Vectorizer for provider '${this.settings.provider}' might be ready or not implemented.`
				);
				// ここでは一旦 true にするが、実際の API Vectorizer 実装で調整が必要
				this.isWorkerReady = true;
				// throw new Error("Unsupported vectorizer type or provider.");
			}

			// CommandHandler を初期化 (vectorizer が準備できた後)
			if (this.isWorkerReady && this.vectorizer) {
				this.commandHandler = new CommandHandler(
					this.app,
					this.vectorizer
				);
				console.log("CommandHandler initialized.");
			} else {
				throw new Error(
					"Vectorizer was not ready after initialization attempt."
				);
			}
		} catch (error) {
			console.error("Failed to initialize resources:", error);
			this.isWorkerReady = false; // 失敗したらフラグを false に
			this.vectorizer = null; // リソースをクリア
			this.commandHandler = null;
			throw error;
		} finally {
			console.log("Resource initialization attempt finished.");
		}
	}

	onunload() {
		console.log("Unloading vector plugin...");
		// Worker を終了させる (WorkerProxyVectorizer の場合のみ)
		if (this.vectorizer instanceof WorkerProxyVectorizer) {
			console.log("Terminating vectorizer worker...");
			this.vectorizer.terminate();
		}
		this.vectorizer = null;
		this.commandHandler = null;
		this.initializationPromise = null;
		this.isWorkerReady = false;
	}
}

// --- Settings Tab Class ---
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
						await this.plugin.saveData(this.plugin.settings);
						// TODO: 可能であれば、ここで動的に再初期化するロジックを追加
					})
			);
	}
}
