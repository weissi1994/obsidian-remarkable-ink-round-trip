/**
 * The owner's handwriting corrections as a training set (ink fork).
 *
 * Worked examples (transport/ocr.ts) teach a vision model this hand for one
 * request at a time. To train it for good — a LoRA adapter, say — the
 * corrections leave the plugin as plain files and the training happens
 * elsewhere, with whatever open tool the owner prefers:
 *
 *   images/<id>.png      the remark's ink
 *   dataset.jsonl        one sample per line, in the ShareGPT-style
 *                        multimodal layout LLaMA-Factory reads
 *                        ({"messages": [...], "images": [...]}, with an
 *                        "<image>" token where the picture goes)
 *   dataset_info.json    the entry that registers it with LLaMA-Factory
 *
 * Each sample asks exactly what the plugin asks at reading time, so a model
 * trained on it is used the way it was taught.
 */

import { ocrPrompt } from "../transport/ocr";
import { corrections, type RemarkRecord, type SampleStore } from "./samples";

/** Dataset name in dataset_info.json. */
export const DATASET_NAME = "remarkable_handwriting";

export interface TrainingSample {
	/** File-safe id: the remark id, or the image name in stores from before ids. */
	id: string;
	/** Image path relative to the export folder. */
	image: string;
	prompt: string;
	text: string;
	record: RemarkRecord;
}

/** The corrected remarks as samples, oldest first. */
export function trainingSamples(store: SampleStore): TrainingSample[] {
	return corrections(store)
		.reverse()
		.map(([key, record]) => {
			const id = (key.split("/").pop() ?? key).replace(/\.png$/i, "").replace(/[^A-Za-z0-9_-]/g, "_");
			return {
				id,
				image: `images/${id}.png`,
				prompt: ocrPrompt({ png: new ArrayBuffer(0), quote: record.quote, wholePage: record.wholePage }),
				text: record.transcript,
				record,
			};
		});
}

/** dataset.jsonl: one conversation per correction. */
export function datasetJsonl(samples: TrainingSample[]): string {
	return samples
		.map((sample) =>
			JSON.stringify({
				messages: [
					{ role: "user", content: `<image>${sample.prompt}` },
					{ role: "assistant", content: sample.text },
				],
				images: [sample.image],
			}),
		)
		.map((line) => `${line}\n`)
		.join("");
}

/** dataset_info.json: registers dataset.jsonl with LLaMA-Factory. */
export function datasetInfo(): string {
	return `${JSON.stringify(
		{
			[DATASET_NAME]: {
				file_name: "dataset.jsonl",
				formatting: "sharegpt",
				columns: { messages: "messages", images: "images" },
				tags: { role_tag: "role", content_tag: "content", user_tag: "user", assistant_tag: "assistant" },
			},
		},
		null,
		2,
	)}\n`;
}
