import { ItemView, WorkspaceLeaf, MarkdownView, TFile } from "obsidian";
import { mount, unmount } from "svelte";
import RelatedChunksComponent from "./RelatedChunksComponent.svelte";
import MyVectorPlugin from "../../main";
import type { SimilarityResultItem } from "../../core/storage/types";

interface SimilarityResultItemWithPreview extends SimilarityResultItem {
	previewText?: string;
}

export const VIEW_TYPE_RELATED_CHUNKS = "related-chunks-sidebar";

export class RelatedChunksView extends ItemView {
	plugin: MyVectorPlugin;
	component?: RelatedChunksComponent;
	currentNoteName: string | null = null;
	currentResults: SimilarityResultItemWithPreview[] = [];
	target: HTMLElement | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: MyVectorPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE_RELATED_CHUNKS;
	}

	getDisplayText(): string {
		return "Related Chunks";
	}
	getIcon(): string {
		return "lucide-link-2";
	}
	async onOpen() {
		this.contentEl.empty();
		this.target = document.createElement("div");
		this.contentEl.appendChild(this.target);

		this.renderComponent();
	}
	private renderComponent() {
		if (this.component) {
			// 既存のコンポーネントがあればアンマウント
			const oldComponent = this.component;
			this.component = undefined; // 先にundefinedにして再帰呼び出しを防ぐ
			try {
				unmount(oldComponent);
			} catch (e) {
				this.plugin.logger?.warn(
					"Error unmounting Svelte component:",
					e
				);
			}
		}

		if (!this.target) return;

		this.component = mount(RelatedChunksComponent, {
			target: this.target,
			props: {
				plugin: this.plugin,
				activeNoteName: this.currentNoteName,
				relatedChunks: this.currentResults,
				onChunkClick: this.handleChunkClick.bind(this),
			},
		}) as RelatedChunksComponent;
	}
	async onClose() {
		if (this.component) {
			const oldComponent = this.component;
			this.component = undefined;
			try {
				unmount(oldComponent);
			} catch (e) {
				this.plugin.logger?.warn(
					"Error unmounting Svelte component on close:",
					e
				);
			}
		}

		if (this.target) {
			this.target.remove();
			this.target = null;
		}
	}
	async updateView(noteName: string | null, results: SimilarityResultItem[]) {
		this.currentNoteName = noteName;
		// results を SimilarityResultItemWithPreview[] に変換
		this.currentResults = await Promise.all(
			results.map(async (item) => {
				const itemWithPreview: SimilarityResultItemWithPreview = {
					...item,
				};
				if (
					item.chunk_offset_start === -1 &&
					item.chunk_offset_end === -1
				) {
					const file = this.plugin.app.vault.getAbstractFileByPath(
						item.file_path
					);
					if (file instanceof TFile) {
						itemWithPreview.previewText = `empty`;
					} else {
						itemWithPreview.previewText = `empty`;
					}
				} else if (
					item.chunk_offset_start != null &&
					item.chunk_offset_end != null
				) {
					try {
						const file =
							this.plugin.app.vault.getAbstractFileByPath(
								item.file_path
							);
						if (file && file instanceof TFile) {
							const content =
								await this.plugin.app.vault.cachedRead(file);
							itemWithPreview.previewText = content.substring(
								item.chunk_offset_start,
								item.chunk_offset_end
							);
						} else {
							itemWithPreview.previewText =
								"File not found for preview.";
						}
					} catch (e) {
						console.error("Error extracting text for preview:", e);
						this.plugin.logger?.error(
							"Error extracting text for preview:",
							e
						);
						itemWithPreview.previewText = "Error loading preview.";
					}
				} else {
					itemWithPreview.previewText =
						"No position info for preview.";
				}
				return itemWithPreview;
			})
		);
		this.renderComponent();
	}

	clearView() {
		this.updateView(null, []);
	}

	private async handleChunkClick(item: SimilarityResultItem) {
		const file = this.app.vault.getAbstractFileByPath(item.file_path);
		if (file && file instanceof TFile) {
			const leaf = this.app.workspace.getLeaf(false);
			await leaf.openFile(file);
			if (leaf.view instanceof MarkdownView) {
				if (item.chunk_offset_start === -1) {
					leaf.view.editor.setCursor({ line: 0, ch: 0 });
					leaf.view.editor.scrollIntoView(
						{ from: { line: 0, ch: 0 }, to: { line: 0, ch: 0 } },
						true
					);
				} else if (item.chunk_offset_start != null) {
					const content = await this.app.vault.cachedRead(file);
					let line = 0;
					let ch = 0;
					let currentOffset = 0;
					for (let i = 0; i < content.length; i++) {
						if (i === item.chunk_offset_start) {
							ch = currentOffset;
							break;
						}
						if (content[i] === "\n") {
							line++;
							currentOffset = 0;
						} else {
							currentOffset++;
						}
					}
					leaf.view.editor.setCursor({ line, ch });
					leaf.view.editor.scrollIntoView(
						{ from: { line, ch }, to: { line, ch } },
						true
					);
				}
			}
		}
	}
}
