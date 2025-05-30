import { TFile, App } from "obsidian";
import { TextChunker } from "../chunking/TextChunker";
import { IntegratedWorkerProxy } from "../workers/IntegratedWorkerProxy";
import type { SimilarityResultItem } from "../storage/types";
import { LoggerService } from "../../shared/services/LoggerService";

export class NoteVectorService {
	constructor(
		private app: App,
		private textChunker: TextChunker,
		private workerProxy: IntegratedWorkerProxy,
		private logger: LoggerService | null
	) {}

	public async getNoteVector(file: TFile): Promise<number[] | null> {
		const content = await this.app.vault.cachedRead(file);
		if (!content.trim()) {
			this.logger?.verbose_log(
				`Note ${file.path} is empty, skipping vector generation.`
			);
			return null;
		}

		const chunkInfos = this.textChunker.chunkText(content, file.path);
		if (chunkInfos.length === 0) {
			this.logger?.verbose_log(
				`No chunks generated for note ${file.path}.`
			);
			return null;
		}

		const chunkTexts = chunkInfos.map((ci) => ci.chunk);

		try {
			const chunkVectors = await this.workerProxy.vectorizeSentences(
				chunkTexts
			);
			if (!chunkVectors || chunkVectors.length === 0) {
				this.logger?.warn(
					`Vectorization returned no vectors for note ${file.path}.`
				);
				return null;
			}
			const noteVector = await this.workerProxy.averageVectors(
				chunkVectors
			);
			return noteVector;
		} catch (error) {
			this.logger?.error(
				`Error generating note vector for ${file.path}:`,
				error
			);
			return null;
		}
	}

	public async getNoteVectorFromDB(file: TFile): Promise<number[] | null> {
		this.logger?.verbose_log(
			`Getting note vector from DB for ${file.path}`
		);
		try {
			const chunkVectors = await this.workerProxy.getVectorsByFilePath(
				file.path
			);

			if (!chunkVectors || chunkVectors.length === 0) {
				this.logger?.verbose_log(
					`No vectors found in DB for note ${file.path}. It might not be vectorized yet.`
				);
				return null;
			}

			this.logger?.verbose_log(
				`Found ${chunkVectors.length} chunk vectors for ${file.path}. Averaging...`
			);
			const noteVector = await this.workerProxy.averageVectors(
				chunkVectors
			);
			return noteVector;
		} catch (error) {
			this.logger?.error(
				`Error getting note vector from DB for ${file.path}:`,
				error
			);
			return null;
		}
	}

	public async findSimilarChunks(
		noteVector: number[],
		limit: number,
		excludeFilePath?: string
	): Promise<SimilarityResultItem[]> {
		if (!noteVector || noteVector.length === 0) {
			return [];
		}
		try {
			const results = await this.workerProxy.searchSimilarByVector(
				noteVector,
				limit,
				excludeFilePath
					? { excludeFilePaths: [excludeFilePath] }
					: undefined
			);
			return results;
		} catch (error) {
			this.logger?.error(
				"Error finding similar chunks by vector:",
				error
			);
			throw error;
		}
	}
}
