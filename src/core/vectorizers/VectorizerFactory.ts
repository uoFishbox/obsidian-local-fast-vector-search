import { IVectorizer } from "./IVectorizer";
import { WorkerProxyVectorizer } from "./WorkerVectorizerProxy";
import { LoggerService } from "../../shared/services/LoggerService";

export interface TransformersVectorizerOptions {
	// modelName: string;
}

export function createTransformersVectorizer(
	logger: LoggerService | null
): IVectorizer {
	return new WorkerProxyVectorizer(logger);
}
