import { IVectorizer } from "./IVectorizer";
import { WorkerProxyVectorizer } from "./WorkerVectorizerProxy";

export interface TransformersVectorizerOptions {
	// modelName: string;
}

export function createTransformersVectorizer(): IVectorizer {
	return new WorkerProxyVectorizer();
}
