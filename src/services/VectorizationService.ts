import { App, TFile } from "obsidian";
import type { IVectorizer } from "../vectorizers/IVectorizer";
import { TextChunker } from "../chunkers/TextChunker";
import type { PGliteVectorStore } from "../storage/pglite/PGliteVectorStore";
import type { VectorItem } from "../core/storage/types";

export class VectorizationService {
	constructor(
		private app: App,
		private vectorizer: IVectorizer,
		private vectorStore: PGliteVectorStore,
		private textChunker: TextChunker
	) {}

	private async generateVectorItemsFromFileContent(
		filePath: string,
		content: string
	): Promise<VectorItem[]> {
		const chunkInfos = this.textChunker.chunkText(content);
		if (chunkInfos.length === 0) return [];

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

	private async saveVectorItemsToStore(
		itemsToInsert: VectorItem[]
	): Promise<number> {
		if (itemsToInsert.length === 0) return 0;
		await this.vectorStore.upsertVectors(itemsToInsert);
		return itemsToInsert.length;
	}

	public async vectorizeAllNotes(
		onProgress?: (message: string, isOverallProgress?: boolean) => void
	): Promise<{ totalVectorsProcessed: number }> {
		const files = this.app.vault.getMarkdownFiles();
		let totalVectorsProcessed = 0;
		const allItemsToInsert: VectorItem[] = [];

		if (onProgress)
			onProgress("Starting vectorization for all notes...", true);

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
					if (onProgress)
						onProgress(`${noticeMessage} (skipped empty)`, false);
					continue;
				}
				const itemsFromFile =
					await this.generateVectorItemsFromFileContent(
						file.path,
						content
					);
				allItemsToInsert.push(...itemsFromFile);
				if (onProgress) onProgress(noticeMessage, false);
			} catch (fileError) {
				console.error(
					`Failed to process file ${file.path}:`,
					fileError
				);
				if (onProgress)
					onProgress(
						`Skipping file ${file.basename} due to error. Check console.`,
						false
					);
				// Consider collecting errors to report at the end
			}
		}

		if (allItemsToInsert.length > 0) {
			if (onProgress)
				onProgress(
					`Saving ${allItemsToInsert.length} total vectors from all notes...`,
					true
				);
			totalVectorsProcessed = await this.saveVectorItemsToStore(
				allItemsToInsert
			);
			console.log(`Upserted ${totalVectorsProcessed} vectors in batch.`);
		} else {
			if (onProgress)
				onProgress("No new vectors to save from any notes.", true);
		}
		return { totalVectorsProcessed };
	}
}
