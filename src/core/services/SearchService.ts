import type { SimilarityResultItem } from "../storage/types";
import { IntegratedWorkerProxy } from "../workers/IntegratedWorkerProxy";

export class SearchService {
	constructor(private workerProxy: IntegratedWorkerProxy) {}

	public async search(
		query: string,
		negativeQuery?: string,
		limit: number = 10
	): Promise<SimilarityResultItem[]> {
		if (!query.trim()) {
			return [];
		}
		try {
			// workerProxy.searchSimilar が内部でベクトル化を行う
			const searchResults = await this.workerProxy.searchSimilar(
				query,
				negativeQuery,
				limit
			);
			return searchResults;
		} catch (error) {
			console.error(
				"Error during similarity search in SearchService:",
				error
			);
			throw error; // Propagate error to CommandHandler
		}
	}
}
