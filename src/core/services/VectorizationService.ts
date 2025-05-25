import { App, TFile } from "obsidian";
import { TextChunker } from "../../core/chunking/TextChunker";
import { LoggerService } from "../../shared/services/LoggerService";
import { IntegratedWorkerProxy } from "../workers/IntegratedWorkerProxy";
import { ChunkInfo } from "../storage/types";

export class VectorizationService {
	private logger: LoggerService | null;
	constructor(
		private app: App,
		private workerProxy: IntegratedWorkerProxy, // IVectorizer と PGliteVectorStore の代わりに workerProxy を使用
		private textChunker: TextChunker,
		logger: LoggerService | null
	) {
		this.logger = logger;
	}
	public async vectorizeAllNotes(
		onProgress?: (message: string, isOverallProgress?: boolean) => void
	): Promise<{ totalVectorsProcessed: number }> {
		const files = this.app.vault.getMarkdownFiles();
		let totalVectorsProcessed = 0;
		const allChunksToProcess: ChunkInfo[] = [];

		if (onProgress)
			onProgress("Starting to scan and chunk all notes...", true);

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
					this.logger?.verbose_log(
						`Skipping empty file: ${file.path}`
					);
					if (onProgress)
						onProgress(`${noticeMessage} (skipped empty)`, false);
					continue;
				}
				const chunkInfos = this.textChunker.chunkText(
					content,
					file.path
				);
				if (chunkInfos.length === 0) {
					this.logger?.verbose_log(
						`No chunks generated for file: ${file.path}`
					);
					if (onProgress)
						onProgress(`${noticeMessage} (no chunks)`, false);
					continue;
				}

				const chunksWithFilePath: ChunkInfo[] = chunkInfos.map(
					(chunk) => ({
						filePath: file.path,
						chunkOffsetStart: chunk.metadata.startPosition,
						chunkOffsetEnd: chunk.metadata.endPosition,
						text: chunk.chunk,
					})
				);
				allChunksToProcess.push(...chunksWithFilePath);
				if (onProgress) onProgress(noticeMessage, false);
			} catch (fileError) {
				this.logger?.error(
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

		// バッチ処理で全チャンクをWorkerに送信
		const WORKER_BATCH_SIZE = 200; // バッチあたりのチャンク数

		if (allChunksToProcess.length > 0) {
			if (onProgress)
				onProgress(
					`Collected ${allChunksToProcess.length} chunks. Starting vectorization and storage in batches...`,
					true
				);

			for (
				let i = 0;
				i < allChunksToProcess.length;
				i += WORKER_BATCH_SIZE
			) {
				const batchChunks = allChunksToProcess.slice(
					i,
					i + WORKER_BATCH_SIZE
				);
				const currentBatchNum = Math.floor(i / WORKER_BATCH_SIZE) + 1;
				const totalBatches = Math.ceil(
					allChunksToProcess.length / WORKER_BATCH_SIZE
				);

				if (onProgress) {
					onProgress(
						`Processing batch ${currentBatchNum}/${totalBatches} (${batchChunks.length} chunks)...`,
						true
					);
				}

				try {
					const result =
						await this.workerProxy.vectorizeAndStoreChunks(
							batchChunks
						);
					totalVectorsProcessed += result.count;
					this.logger?.verbose_log(
						`Batch ${currentBatchNum}/${totalBatches} processed. Upserted ${result.count} vectors. Total processed: ${totalVectorsProcessed}`
					);
				} catch (batchError) {
					this.logger?.error(
						`Error processing batch ${currentBatchNum}/${totalBatches} (starting at index ${i}):`,
						batchError
					);
					// エラーが発生した場合、処理を中断してエラーを伝播させる
					throw batchError;
				}
			}

			if (onProgress)
				onProgress(
					`All ${Math.ceil(
						allChunksToProcess.length / WORKER_BATCH_SIZE
					)} batches processed. Total vectors upserted: ${totalVectorsProcessed}.`,
					true
				);
		} else {
			if (onProgress)
				onProgress("No new chunks to process from any notes.", true);
		}
		return { totalVectorsProcessed };
	}

	public async vectorizeSingleFile(
		file: TFile,
		contentToProcess?: string
	): Promise<{ vectorsProcessed: number; vectorsDeleted: number }> {
		this.logger?.log(`Vectorizing single file: ${file.path}`);

		const vectorsDeleted = await this.deleteVectorsForFile(file.path);
		let vectorsProcessed = 0;

		const currentContent =
			contentToProcess ?? (await this.app.vault.cachedRead(file));

		if (!currentContent.trim()) {
			this.logger?.verbose_log(
				`Skipping empty file or file became empty: ${file.path}. Vectors deleted: ${vectorsDeleted}`
			);
			return { vectorsProcessed, vectorsDeleted };
		}

		const chunkInfosFromTextChunker = this.textChunker.chunkText(
			currentContent,
			file.path
		);

		if (chunkInfosFromTextChunker.length === 0) {
			this.logger?.verbose_log(
				`No chunks generated for file: ${file.path} during update. Existing vectors (if any) were deleted: ${vectorsDeleted}`
			);
			return { vectorsProcessed, vectorsDeleted };
		}

		const chunksToStore: ChunkInfo[] = chunkInfosFromTextChunker.map(
			(chunk) => ({
				filePath: file.path,
				chunkOffsetStart: chunk.metadata.startPosition,
				chunkOffsetEnd: chunk.metadata.endPosition,
				text: chunk.chunk,
			})
		);

		try {
			const result = await this.workerProxy.vectorizeAndStoreChunks(
				chunksToStore
			);
			vectorsProcessed = result.count;
			this.logger?.verbose_log(
				`File ${file.path} processed. Upserted ${vectorsProcessed} vectors. Previously deleted: ${vectorsDeleted}`
			);
		} catch (error) {
			this.logger?.error(
				`Error vectorizing and storing chunks for ${file.path}:`,
				error
			);
			throw error;
		}

		return { vectorsProcessed, vectorsDeleted };
	}

	public async deleteVectorsForFile(filePath: string): Promise<number> {
		try {
			this.logger?.verbose_log(
				`Requesting deletion of vectors for file: ${filePath}`
			);
			const deletedCount = await this.workerProxy.deleteVectorsByFilePath(
				filePath
			);
			this.logger?.verbose_log(
				`Deleted ${deletedCount} vectors for file: ${filePath}`
			);
			return deletedCount;
		} catch (error) {
			this.logger?.error(
				`Error deleting vectors for file ${filePath}:`,
				error
			);
			throw error;
		}
	}
}
