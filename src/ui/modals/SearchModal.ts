import { App, Modal, Setting, TFile } from "obsidian";
import { CommandHandler } from "../../commands";
import type { SimilarityResultItem } from "../../core/storage/types";
import { NotificationService } from "../../shared/services/NotificationService";
import { PluginSettings } from "../../pluginSettings";

export class SearchModal extends Modal {
	private commandHandler: CommandHandler;
	private notificationService: NotificationService;
	private query: string = "";
	private results: SimilarityResultItem[] = [];
	private resultsEl!: HTMLElement;

	constructor(
		app: App,
		commandHandler: CommandHandler,
		notificationService: NotificationService,
		private pluginSettings: PluginSettings
	) {
		super(app);
		this.commandHandler = commandHandler;
		this.notificationService = notificationService;
		this.pluginSettings = pluginSettings;
		this.modalEl.addClass("vector-search-modal");
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: "Search Similar Notes" });

		const searchInputSetting = new Setting(contentEl)
			.setName("Search Query")
			.addText((text) => {
				text.setPlaceholder("Enter your query")
					.setValue(this.query)
					.onChange((value) => {
						this.query = value;
					});
				text.inputEl.addEventListener("keydown", (e: KeyboardEvent) => {
					if (e.key === "Enter") {
						e.preventDefault();
						this.performSearch();
					}
				});
				setTimeout(() => text.inputEl.focus(), 0);
			});
		searchInputSetting.controlEl.addClass("vector-search-input-control");

		new Setting(contentEl).addButton((button) => {
			button
				.setButtonText("Search")
				.setCta()
				.onClick(() => {
					this.performSearch();
				});
		});

		this.resultsEl = contentEl.createDiv("vector-search-results");
		this.renderResults();
	}

	async performSearch() {
		if (!this.query.trim()) {
			this.notificationService.showNotice("Please enter a search query.");
			return;
		}
		if (!this.commandHandler) {
			this.notificationService.showNotice(
				"CommandHandler is not available. Please try reloading the plugin."
			);
			return;
		}

		const noticeId = this.notificationService.showNotice("Searching...", 0);
		try {
			this.results = await this.commandHandler.searchSimilarNotes(
				this.query,
				this.pluginSettings.searchResultLimit
			);
			await this.renderResults();
			this.notificationService.showNotice(
				`Found ${this.results.length} similar notes.`
			);
		} catch (error: any) {
			console.error("Error during search:", error);
			this.notificationService.showNotice(
				`Search failed: ${error.message}`
			);
			this.results = [];
			await this.renderResults();
			this.notificationService.showNotice("Search failed.");
		} finally {
			this.notificationService.hideNotice(noticeId);
		}
	}

	async renderResults() {
		this.resultsEl.empty();
		if (this.results.length === 0) {
			this.resultsEl.createEl("p", {
				text: "No results found or query not yet run.",
			});
			return;
		}

		const ul = this.resultsEl.createEl("ul");
		ul.addClass("vector-search-result-list");

		for (const result of this.results) {
			const li = ul.createEl("li");
			li.addClass("vector-search-result-item");

			const file = this.app.vault.getAbstractFileByPath(result.file_path);
			let fileName = result.file_path;
			if (file instanceof TFile) {
				fileName = file.basename;
			}

			const link = li.createEl("a", {
				text: `${fileName} (Distance: ${result.distance.toFixed(4)})`,
				href: "#",
			});
			link.addClass("vector-search-result-link");
			link.addEventListener("click", (e) => {
				e.preventDefault();
				this.app.workspace.openLinkText(
					result.file_path,
					result.file_path,
					false
				);
				this.close();
			});

			if (file instanceof TFile) {
				try {
					const fileContent = await this.app.vault.cachedRead(file);
					if (
						result.chunk_offset_start !== null &&
						result.chunk_offset_end !== null
					) {
						const chunkContent = fileContent.substring(
							result.chunk_offset_start,
							result.chunk_offset_end
						);
						const contentPreview = li.createEl("p", {
							text: `Chunk: ${chunkContent.substring(0, 200)}${
								chunkContent.length > 200 ? "..." : ""
							}`,
						});
						contentPreview.addClass("vector-search-result-content");
					} else if (result.chunk) {
						// chunk_offset がない場合は chunk フィールドを使用
						const contentPreview = li.createEl("p", {
							text: `Chunk: ${result.chunk.substring(0, 200)}${
								result.chunk.length > 200 ? "..." : ""
							}`,
						});
						contentPreview.addClass("vector-search-result-content");
					}
				} catch (error) {
					console.error("Error reading file content:", error);
					li.createEl("p", {
						text: "Failed to load chunk content",
						cls: "vector-search-result-content",
					});
				}
			} else {
				li.createEl("p", {
					text: "File not found",
					cls: "vector-search-result-content",
				});
			}
		}
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}
