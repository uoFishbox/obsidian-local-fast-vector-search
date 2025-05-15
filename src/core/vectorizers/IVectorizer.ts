// Interface for all vectorizer implementations
export interface IVectorizer {
	/**
	 * Convert input sentences into embedding vectors.
	 * @param sentences Array of input strings
	 * @returns Promise resolving to array of normalized vectors
	 */
	vectorizeSentences(sentences: string[]): Promise<number[][]>;
}
