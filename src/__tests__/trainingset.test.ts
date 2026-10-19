import { describe, expect, it } from "vitest";
import { emptyStore, rememberRemark } from "../ocr/samples";
import { DATASET_NAME, datasetInfo, datasetJsonl, trainingSamples } from "../ocr/trainingset";
import { ocrPrompt } from "../transport/ocr";

function store() {
	const s = emptyStore();
	const ink = [[{ x: 0, y: 0 }]];
	rememberRemark(s, "3f9a2c1b0d4e", ink, "Termin morgan", new Date("2026-10-02"), { quote: "Planung" });
	rememberRemark(s, "reMarkable-in/handwriting/dev-p01-2.png", ink, "x", new Date("2026-10-01"));
	rememberRemark(s, "aaaaaaaaaaaa", ink, "never corrected", new Date("2026-10-03"));
	Object.assign(s.remarks["3f9a2c1b0d4e"], { corrected: true, transcript: "Termin morgen" });
	Object.assign(s.remarks["reMarkable-in/handwriting/dev-p01-2.png"], { corrected: true, transcript: "prüfen" });
	return s;
}

describe("training export", () => {
	it("holds the corrected remarks only, oldest first, with file-safe ids", () => {
		const samples = trainingSamples(store());
		expect(samples.map((s) => [s.id, s.image, s.text])).toEqual([
			["dev-p01-2", "images/dev-p01-2.png", "prüfen"],
			["3f9a2c1b0d4e", "images/3f9a2c1b0d4e.png", "Termin morgen"],
		]);
	});

	it("asks what the plugin asks when reading, context line included", () => {
		const [, withQuote] = trainingSamples(store());
		expect(withQuote.prompt).toBe(ocrPrompt({ png: new ArrayBuffer(0), quote: "Planung" }));
	});

	it("writes LLaMA-Factory's multimodal ShareGPT layout", () => {
		const lines = datasetJsonl(trainingSamples(store())).trimEnd().split("\n").map((l) => JSON.parse(l) as unknown);
		expect(lines).toHaveLength(2);
		expect(lines[1]).toEqual({
			messages: [
				{ role: "user", content: `<image>${ocrPrompt({ png: new ArrayBuffer(0), quote: "Planung" })}` },
				{ role: "assistant", content: "Termin morgen" },
			],
			images: ["images/3f9a2c1b0d4e.png"],
		});
		const info = JSON.parse(datasetInfo()) as Record<string, unknown>;
		expect(info[DATASET_NAME]).toMatchObject({ file_name: "dataset.jsonl", formatting: "sharegpt" });
	});
});
