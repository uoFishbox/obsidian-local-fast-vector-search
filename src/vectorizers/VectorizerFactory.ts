import { IVectorizer } from "./IVectorizer";
import { WorkerProxyVectorizer } from "./WorkerProxyVectorizer";

export interface TransformersVectorizerOptions {
	// modelName: string;
}

export function createTransformersVectorizer(): IVectorizer {
	return new WorkerProxyVectorizer();
}
