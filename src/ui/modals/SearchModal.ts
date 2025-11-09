import { App, SuggestModal, TFile } from "obsidian";
import { CommandHandler } from "../../commands";
import type { SimilarityResultItem } from "../../core/storage/types";
import { NotificationService } from "../../shared/services/NotificationService";
import { type PluginSettings } from "../../pluginSettings";

function parseQueryString(queryString: string): {
	positiveQuery: string;
	negativeQuery?: string;
} {
	const parts = queryString.split(/-(.+)/s, 2);
	const positiveQuery = parts[0].trim();
	let negativeQuery: string | undefined = undefined;

	if (parts.length > 1 && parts[1]) {
		negativeQuery = parts[1].trim();
		if (negativeQuery === "") {
			negativeQuery = undefined;
		}
	}
	return { positiveQuery, negativeQuery };
}

export class SearchModal extends SuggestModal<SimilarityResultItem> {
	private commandHandler: CommandHandler;
	private notificationService: NotificationService;
	private pluginSettings: PluginSettings;
	private debounceTimer: NodeJS.Timeout | null = null;
	private debounceDelay: number = 500; // ms

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
		this.setPlaceholder(
			"Enter query (e.g., 'positive terms -negative terms')"
		);
	}

	async getSuggestions(query: string): Promise<SimilarityResultItem[]> {
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
		}

		// 空のクエリの場合は即座に返す
		if (!query.trim()) {
			return [];
		}

		return new Promise((resolve) => {
			this.debounceTimer = setTimeout(async () => {
				if (!this.commandHandler) {
					console.error(
						"CommandHandler is not available. Please try reloading the plugin."
					);
					resolve([]);
					return;
				}

				const { positiveQuery, negativeQuery } =
					parseQueryString(query);

				if (!positiveQuery) {
					resolve([]);
					return;
				}

				try {
					const results =
						await this.commandHandler.searchSimilarNotes(
							positiveQuery,
							negativeQuery,
							this.pluginSettings.searchResultLimit
						);
					resolve(results);
				} catch (error: any) {
					console.error("Error during search:", error);
					resolve([]);
				}
			}, this.debounceDelay);
		});
	}

	private async extractTextFromPosition(
		filePath: string,
		startPosition: number,
		endPosition: number
	): Promise<string> {
		if (startPosition === -1 && endPosition === -1) {
			const file = this.app.vault.getAbstractFileByPath(filePath);
			if (file instanceof TFile) {
				return `empty`;
			}
			return `empty`;
		}
		try {
			const file = this.app.vault.getAbstractFileByPath(filePath);
			if (!(file instanceof TFile)) {
				return "ファイルが見つかりません";
			}

			const content = await this.app.vault.cachedRead(file);
			const extractedText = content.substring(startPosition, endPosition);

			const cleanedText = extractedText.replace(/\n/g, " ");
			return cleanedText;
		} catch (error) {
			console.error("Error reading file:", error);
			return "テキストの読み込みエラー";
		}
	}

	async renderSuggestion(result: SimilarityResultItem, el: HTMLElement) {
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

		// 位置情報からテキストを抽出して表示
		const extractedText = await this.extractTextFromPosition(
			result.file_path,
			result.chunk_offset_start || 0,
			result.chunk_offset_end || 0
		);

		el.createEl("div", {
			text: extractedText,
			cls: "vector-search-result-chunk",
		});
	}

	onChooseSuggestion(
		item: SimilarityResultItem,
		evt: MouseEvent | KeyboardEvent
	) {
		this.app.workspace.openLinkText(item.file_path, item.file_path, false);
	}

	onClose() {
		super.onClose();
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
		}
	}
}
