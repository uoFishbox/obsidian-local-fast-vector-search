import type {
	AutoModelType,
	AutoTokenizerType,
	PreTrainedModelType,
	PreTrainedTokenizerType,
} from "./types";

export async function initializeTransformers(
	AutoModel: AutoModelType,
	AutoTokenizer: AutoTokenizerType
): Promise<{
	model: PreTrainedModelType;
	tokenizer: PreTrainedTokenizerType;
}> {
	try {
		console.log("Starting model download/load...");
		const modelStartTime = performance.now();

		const model = await AutoModel.from_pretrained(
			"cfsdwe/static-embedding-japanese-for-js",
			{ device: "wasm", dtype: "q8" }
		);

		const modelEndTime = performance.now();
		console.log(
			`Model loaded in ${((modelEndTime - modelStartTime) / 1000).toFixed(
				2
			)} seconds. Starting tokenizer download/load...`
		);

		const tokenizerStartTime = performance.now();

		const tokenizer = await AutoTokenizer.from_pretrained(
			"cfsdwe/static-embedding-japanese-for-js"
		);

		const tokenizerEndTime = performance.now();
		console.log(
			`Tokenizer loaded in ${(
				(tokenizerEndTime - tokenizerStartTime) /
				1000
			).toFixed(2)} seconds.`
		);

		return { model, tokenizer };
	} catch (error) {
		console.error(
			"Model/Tokenizer Initialization Error in external function:",
			error
		);
		throw error;
	}
}
