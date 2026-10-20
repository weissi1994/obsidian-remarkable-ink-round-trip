import { describe, expect, it } from "vitest";
import { CURRENT_FORMAT, emptyStore, migrate, type RemarkRecord } from "../ocr/samples";

/** A minimal but valid RemarkRecord, enough to prove containers are preserved intact. */
const remark: RemarkRecord = {
	strokes: [[{ x: 1, y: 2 }, { x: 3, y: 4 }]],
	transcript: "Termin",
	at: "2026-01-01T00:00:00.000Z",
	corrected: true,
};

describe("migrate: sample store version ladder", () => {
	it("upgrades a format-1 store losslessly to the current format", () => {
		// A hand-written format-1 blob with no `letters` — the shape that lives on
		// disk in stores written before this change.
		const fixture = {
			format: 1,
			words: { und: [[[{ x: 0, y: 0 }, { x: 10, y: 10 }]]] },
			remarks: { r1: { ...remark } },
		};
		const before = JSON.parse(JSON.stringify(fixture));

		const out = migrate(fixture);

		// Red gate: on main there is no `migrate`; the raw cast leaves `format: 1`,
		// so this assertion fails before the seam exists.
		expect(out.format).toBe(2);
		expect(out.format).toBe(CURRENT_FORMAT);
		expect(out.words).toEqual(before.words);
		expect(out.remarks).toEqual(before.remarks);
		// Optional field left exactly as-is: absent-or-empty.
		expect(out.letters ?? {}).toEqual({});
	});

	it("is idempotent on an empty current store and stays at the current format", () => {
		const out = migrate(emptyStore());
		expect(out.format).toBe(CURRENT_FORMAT);
		expect(out.words).toEqual({});
		expect(out.remarks).toEqual({});
		// migrate(migrate(x)) === migrate(x)
		expect(migrate(out)).toEqual(out);
	});

	it("round-trips a current store through JSON unchanged", () => {
		const store = emptyStore();
		store.words.und = [[[{ x: 1, y: 1 }]]];
		store.remarks.r1 = { ...remark };
		store.letters = { a: [[[{ x: 0, y: 0 }]]] };

		expect(migrate(JSON.parse(JSON.stringify(store)))).toEqual(store);
	});

	it("preserves a store written by a newer plugin build (downgrade-safe)", () => {
		const future = {
			format: 99,
			words: { und: [[[{ x: 2, y: 2 }]]] },
			remarks: {},
			joins: { x: 1 }, // a field this build does not know about
		};
		const out = migrate(future) as typeof future;
		expect(out.words).toEqual(future.words);
		expect(out.joins).toEqual(future.joins);
	});

	it("returns a valid empty current store for garbage input, never throwing", () => {
		for (const garbage of [null, undefined, 42, "store", [], true]) {
			const out = migrate(garbage);
			expect(out.format).toBe(CURRENT_FORMAT);
			expect(out.words).toEqual({});
			expect(out.remarks).toEqual({});
		}
	});

	it("defaults absent containers rather than leaving them undefined", () => {
		const out = migrate({ format: 2 });
		expect(out.words).toEqual({});
		expect(out.remarks).toEqual({});
	});
});
