import { App, SuggestModal, TFile } from "obsidian";
import { CommandHandler } from "../../commands";
import type { SimilarityResultItem } from "../../core/storage/types";
import { NotificationService } from "../../shared/services/NotificationService";
import { type PluginSettings } from "../../pluginSettings";
import { EditorView, keymap } from "@codemirror/view";
import { EditorState, Prec } from "@codemirror/state";
import { placeholder } from "@codemirror/view";

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
	private shouldPerformSearch: boolean = false;

	private cmView: EditorView | null = null;
	private editorContainer: HTMLElement | null = null;

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
	}

	onOpen() {
		super.onOpen();
		this.inputEl.style.display = "none";
		this.editorContainer = this.contentEl.createDiv({
			cls: "cm-suggest-editor-container",
		});

		if (this.inputEl.parentNode) {
			this.inputEl.parentNode.insertBefore(
				this.editorContainer,
				this.inputEl
			);
		} else {
			this.contentEl.appendChild(this.editorContainer);
		}

		const initialState = EditorState.create({
			doc: this.inputEl.value,
			extensions: [
				placeholder(
					"Enter query (e.g., 'positive terms -negative terms')"
				),
				EditorView.updateListener.of((update) => {
					if (update.docChanged && this.cmView) {
						// CodeMirror の内容を非表示の inputEl.value と同期させる
						// SuggestModal の内部がそれに依存している場合に重要
						this.inputEl.value = this.cmView.state.doc.toString();
					}
				}),
				Prec.highest(
					keymap.of([
						{
							key: "Tab",
							run: (view: EditorView): boolean => {
								const query = view.state.doc.toString();
								if (query.trim()) {
									this.inputEl.value = query;
									this.shouldPerformSearch = true;
									// Tab キーが押されたときに input イベントをディスパッチ
									this.inputEl.dispatchEvent(
										new Event("input")
									);
								}
								return true;
							},
						},
					])
				),
			],
		});

		this.cmView = new EditorView({
			state: initialState,
			parent: this.editorContainer,
		});
		this.cmView.focus();
	}

	async getSuggestions(query: string): Promise<SimilarityResultItem[]> {
		// クエリは this.inputEl.value から取得され、CodeMirror によって更新される。
		// 'input' イベントは Tabによってディスパッチされる。
		if (!query.trim()) {
			this.shouldPerformSearch = false;
			return [];
		}
		if (!this.commandHandler) {
			this.notificationService.showNotice(
				"CommandHandler is not available. Please try reloading the plugin."
			);
			this.shouldPerformSearch = false;
			return [];
		}

		if (!this.shouldPerformSearch) {
			return [];
		}

		const { positiveQuery, negativeQuery } = parseQueryString(query);

		if (!positiveQuery) {
			this.notificationService.showNotice(
				"Positive search query cannot be empty.",
				3000
			);
			this.shouldPerformSearch = false;
			return [];
		}

		const noticeId = this.notificationService.showNotice("Searching...", 0);
		try {
			const results = await this.commandHandler.searchSimilarNotes(
				positiveQuery,
				negativeQuery,
				this.pluginSettings.searchResultLimit
			);
			this.notificationService.updateNotice(
				noticeId,
				`Found ${results.length} similar notes.`,
				results.length > 0 ? 3000 : 1000
			);
			return results;
		} catch (error: any) {
			console.error("Error during search:", error);
			this.notificationService.updateNotice(
				noticeId,
				`Search failed: ${error.message}`,
				5000
			);
			return [];
		} finally {
			this.shouldPerformSearch = false;
		}
	}

	// ファイルから位置情報を使ってテキストを抽出するメソッド
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

		// CodeMirror インスタンスを破棄
		if (this.cmView) {
			this.cmView.destroy();
			this.cmView = null;
		}
		// エディタコンテナを DOM から削除
		if (this.editorContainer) {
			this.editorContainer.remove();
			this.editorContainer = null;
		}
	}
}
