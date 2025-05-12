import { Notice, App } from "obsidian";
import type { IVectorizer } from "./vectorizers/IVectorizer";
import { TextChunker } from "./chunkers/TextChunker";
import type {
	PGliteVectorStore,
	VectorItem,
	SimilarityResultItem,
} from "./storage/PGliteVectorStore";

export class CommandHandler {
	private app: App;
	private vectorizer: IVectorizer;
	private vectorStore: PGliteVectorStore;
	private textChunker: TextChunker;

	constructor(
		app: App,
		vectorizer: IVectorizer,
		vectorStore: PGliteVectorStore
	) {
		this.app = app;
		this.vectorizer = vectorizer;
		this.vectorStore = vectorStore;
		this.textChunker = new TextChunker({});
	}

	private _showNotice(
		message: string,
		timeout: number = 0,
		existingNotice?: Notice
	): Notice {
		if (existingNotice) {
			existingNotice.setMessage(message);
			if (timeout > 0) {
				setTimeout(() => existingNotice.hide(), timeout);
			}
			return existingNotice;
		}
		const newNotice = new Notice(message, timeout);
		return newNotice;
	}

	private async _generateVectorItemsFromFileContent(
		filePath: string,
		content: string
	): Promise<VectorItem[]> {
		const chunkInfos = this.textChunker.chunkText(content);
		if (chunkInfos.length === 0) {
			return [];
		}

		const sentences = chunkInfos.map((chunk) => chunk.chunk);
		const vectors = await this.vectorizer.vectorizeSentences(sentences);

		return chunkInfos
			.map((chunkInfo, i) => {
				if (vectors[i]) {
					return {
						filePath: filePath,
						chunkOffsetStart: chunkInfo.metadata.startPosition,
						chunkOffsetEnd: chunkInfo.metadata.endPosition,
						vector: vectors[i],
					};
				}
				return null;
			})
			.filter((item): item is VectorItem => item !== null);
	}

	private async _saveVectorItemsToStore(
		itemsToInsert: VectorItem[]
	): Promise<number> {
		if (itemsToInsert.length === 0) {
			return 0;
		}
		await this.vectorStore.upsertVectors(itemsToInsert);
		await this.vectorStore.save();
		return itemsToInsert.length;
	}

	async vectorizeAllNotes(): Promise<void> {
		const files = this.app.vault.getMarkdownFiles();
		if (files.length === 0) {
			this._showNotice("No markdown files found to vectorize.", 3000);
			return;
		}

		let vectorizeNotice = this._showNotice(
			"Starting vectorization for all notes..."
		);
		const startAll = performance.now();
		let totalVectorsProcessed = 0;
		const allItemsToInsert: VectorItem[] = [];

		try {
			for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
				const file = files[fileIndex];
				const progressPercent = (
					((fileIndex + 1) / files.length) *
					100
				).toFixed(1);
				let noticeMessage = `Processing file ${fileIndex + 1}/${
					files.length
				} (${progressPercent}%): ${file.basename}`;

				try {
					const content = await this.app.vault.cachedRead(file);
					if (!content.trim()) {
						console.log(`Skipping empty file: ${file.path}`);
						noticeMessage += " (skipped empty)";
						this._showNotice(noticeMessage, 0, vectorizeNotice);
						continue;
					}
					const itemsFromFile =
						await this._generateVectorItemsFromFileContent(
							file.path,
							content
						);
					allItemsToInsert.push(...itemsFromFile);
					this._showNotice(noticeMessage, 0, vectorizeNotice);
				} catch (fileError) {
					console.error(
						`Failed to process file ${file.path}:`,
						fileError
					);
					this._showNotice(
						`Skipping file ${file.basename} due to error. Check console.`,
						3000
					);
					noticeMessage += " (skipped due to error)";
					this._showNotice(noticeMessage, 0, vectorizeNotice);
					continue;
				}
			}

			if (allItemsToInsert.length > 0) {
				this._showNotice(
					`Saving ${allItemsToInsert.length} total vectors from all notes...`,
					0,
					vectorizeNotice
				);
				totalVectorsProcessed = await this._saveVectorItemsToStore(
					allItemsToInsert
				);
				console.log(
					`Upserted ${totalVectorsProcessed} vectors in batch.`
				);
			} else {
				this._showNotice(
					"No new vectors to save from any notes.",
					0,
					vectorizeNotice
				);
			}

			const totalTime = (performance.now() - startAll) / 1000;
			this._showNotice(
				`Vectorization finished! ${totalVectorsProcessed} vectors saved in ${totalTime.toFixed(
					2
				)}s.`,
				5000,
				vectorizeNotice
			);
			console.log(
				`All notes vectorized and saved in ${totalTime.toFixed(
					2
				)}s. Total vectors processed: ${totalVectorsProcessed}`
			);
		} catch (error) {
			console.error(
				"Vectorization of all notes failed unexpectedly:",
				error
			);
			this._showNotice(
				"Vectorization failed during processing. Check console.",
				5000,
				vectorizeNotice
			);
		}
	}

	async rebuildAllIndexes(): Promise<void> {
		let rebuildStatusNotice = this._showNotice(
			"Rebuilding all indexes... This may take a while."
		);

		try {
			this._showNotice(
				"Rebuilding storage and clearing old index data...",
				0,
				rebuildStatusNotice
			);
			console.log(
				"Rebuilding index: Calling vectorStore.rebuildStorage()."
			);
			await this.vectorStore.rebuildStorage();
			console.log("Storage rebuild completed by vectorStore.");

			this._showNotice(
				"Storage cleared. Re-vectorizing all notes...",
				0,
				rebuildStatusNotice
			);

			rebuildStatusNotice.hide();
			await this.vectorizeAllNotes();

			console.log(
				"Index rebuild process completed successfully by vectorizeAllNotes."
			);
		} catch (error: any) {
			console.error("Failed to rebuild all indexes:", error);
			this._showNotice(
				`Index rebuild failed: ${
					error.message || "Unknown error"
				}. Check console.`,
				7000,
				rebuildStatusNotice
			);
		}
	}

	async searchSimilarNotes(
		query: string,
		limit: number = 10
	): Promise<SimilarityResultItem[]> {
		if (!query.trim()) {
			this._showNotice("Query cannot be empty.", 3000);
			return [];
		}

		try {
			const queryVectorArray = await this.vectorizer.vectorizeSentences([
				query,
			]);
			if (
				!queryVectorArray ||
				queryVectorArray.length === 0 ||
				!queryVectorArray[0]
			) {
				throw new Error(
					"Failed to vectorize query. The vectorizer might not be ready, the query could be invalid, or the resulting vector is empty."
				);
			}
			const queryVector = queryVectorArray[0];

			const results = await this.vectorStore.searchSimilar(
				queryVector,
				limit
			);

			return results;
		} catch (error) {
			console.error("Error during similarity search:", error);
			this._showNotice(
				`Search failed: ${
					error instanceof Error ? error.message : "Unknown error"
				}. Check console.`,
				5000
			);
			throw error;
		}
	}
}
