import { App, SuggestModal, TFile } from "obsidian";
import { CommandHandler } from "../../commands";
import type { SimilarityResultItem } from "../../core/storage/types";
import { NotificationService } from "../../shared/services/NotificationService";
import { PluginSettings } from "../../pluginSettings";

export class SearchModal extends SuggestModal<SimilarityResultItem> {
	private commandHandler: CommandHandler;
	private notificationService: NotificationService;
	private pluginSettings: PluginSettings;
	private shouldPerformSearch: boolean = false;

	constructor(
		app: App,
		commandHandler: CommandHandler,
		notificationService: NotificationService,
		pluginSettings: PluginSettings
	) {
		super(app);
		this.commandHandler = commandHandler;
		this.notificationService = notificationService;
		this.pluginSettings = pluginSettings;

		this.containerEl.addClass("vector-search-modal");
		this.inputEl.placeholder = "Enter your search query...";

		this.inputEl.addEventListener(
			"keydown",
			async (event: KeyboardEvent) => {
				if (event.key === "Tab") {
					event.preventDefault();
					const query = this.inputEl.value;
					if (query.trim()) {
						this.shouldPerformSearch = true;
						this.inputEl.dispatchEvent(new Event("input"));
					}
				}
			}
		);
	}

	async getSuggestions(query: string): Promise<SimilarityResultItem[]> {
		if (!query.trim()) {
			return [];
		}
		if (!this.commandHandler) {
			this.notificationService.showNotice(
				"CommandHandler is not available. Please try reloading the plugin."
			);
			return [];
		}

		// Tabキーが押された場合のみ検索
		if (!this.shouldPerformSearch) {
			return [];
		}

		const noticeId = this.notificationService.showNotice("Searching...", 0);
		try {
			const results = await this.commandHandler.searchSimilarNotes(
				query,
				this.pluginSettings.searchResultLimit
			);
			this.notificationService.showNotice(
				`Found ${results.length} similar notes.`
			);
			return results;
		} catch (error: any) {
			console.error("Error during search:", error);
			this.notificationService.showNotice(
				`Search failed: ${error.message}`
			);
			return [];
		} finally {
			this.notificationService.hideNotice(noticeId);
			this.shouldPerformSearch = false;
		}
	}

	renderSuggestion(result: SimilarityResultItem, el: HTMLElement) {
		el.addClass("vector-search-result-item");

		const file = this.app.vault.getAbstractFileByPath(result.file_path);
		let fileName = result.file_path;
		if (file instanceof TFile) {
			fileName = file.basename;
		}

		el.createEl("div", {
			text: `${fileName} (Distance: ${result.distance.toFixed(4)})`,
			cls: "vector-search-result-link",
		});
	}

	onChooseSuggestion(
		item: SimilarityResultItem,
		evt: MouseEvent | KeyboardEvent
	) {
		this.app.workspace.openLinkText(item.file_path, item.file_path, false);
	}
}
