import type { IVectorizer } from "../vectorizers/IVectorizer";
import type { PGliteVectorStore } from "../storage/pglite/PGliteVectorStore";
import type { SimilarityResultItem } from "../core/storage/types";

export class SearchService {
	constructor(
		private vectorizer: IVectorizer,
		private vectorStore: PGliteVectorStore
	) {}

	public async search(
		query: string,
		limit: number = 10
	): Promise<SimilarityResultItem[]> {
		if (!query.trim()) {
			// Or throw an error to be caught by CommandHandler
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
					"Failed to vectorize query. The vectorizer might not be ready or the query is invalid."
				);
			}
			const queryVector = queryVectorArray[0];
			return await this.vectorStore.searchSimilar(queryVector, limit);
		} catch (error) {
			console.error(
				"Error during similarity search in SearchService:",
				error
			);
			throw error; // Propagate error to CommandHandler
		}
	}
}
