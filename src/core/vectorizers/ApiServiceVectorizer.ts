import { IVectorizer } from "./IVectorizer";

/**
 * Vectorizer implementation using generic external API service
 */
export class ApiServiceVectorizer implements IVectorizer {
	private endpoint: string;
	private apiKey?: string;

	constructor(endpoint: string, apiKey?: string) {
		this.endpoint = endpoint;
		this.apiKey = apiKey;
	}

	async vectorizeSentences(sentences: string[]): Promise<number[][]> {
		// TODO: call external API
		throw new Error("ApiServiceVectorizer is not implemented yet.");
	}
}
