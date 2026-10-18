import { describe, expect, it } from "vitest";
import type { RoundTripSettings } from "../settingsmodel";
import {
	DEFAULT_SETTINGS,
	LAYOUT_PRESETS,
	breakLevelFor,
	layoutFor,
	packFor,
	sendLayout,
	settingsFrom,
} from "../settingsmodel";

describe("layout presets (GP_E6_S3)", () => {
	it("custom uses the sliders as they are", () => {
		const settings = { ...DEFAULT_SETTINGS, fontSize: 12.5, lineHeight: 1.7, margin: 48 };
		expect(layoutFor(settings)).toEqual({ fontSize: 12.5, lineHeight: 1.7, margin: 48 });
	});

	it("a preset overrides the sliders with its bundle", () => {
		const settings = { ...DEFAULT_SETTINGS, layoutPreset: "compact" as const, fontSize: 14 };
		expect(layoutFor(settings)).toEqual(LAYOUT_PRESETS.compact);
	});

	it("presets stay within the sliders' own ranges", () => {
		for (const preset of Object.values(LAYOUT_PRESETS)) {
			expect(preset.fontSize).toBeGreaterThanOrEqual(9);
			expect(preset.fontSize).toBeLessThanOrEqual(14);
			expect(preset.lineHeight).toBeGreaterThanOrEqual(1.2);
			expect(preset.lineHeight).toBeLessThanOrEqual(1.9);
			expect(preset.margin).toBeGreaterThanOrEqual(24);
			expect(preset.margin).toBeLessThanOrEqual(64);
		}
	});
});

describe("heading-break level (GP_E6_S4, smart via GP_E6_S9)", () => {
	it("maps the setting to the typesetter's level; smart breaks no level", () => {
		expect(breakLevelFor({ ...DEFAULT_SETTINGS, pageBreakAtHeading: "off" })).toBe(0);
		expect(breakLevelFor({ ...DEFAULT_SETTINGS, pageBreakAtHeading: "h1" })).toBe(1);
		expect(breakLevelFor({ ...DEFAULT_SETTINGS, pageBreakAtHeading: "h2" })).toBe(2);
		expect(breakLevelFor({ ...DEFAULT_SETTINGS, pageBreakAtHeading: "smart" })).toBe(0);
	});

	it("packs sections only on smart, the default for fresh installs", () => {
		expect(DEFAULT_SETTINGS.pageBreakAtHeading).toBe("smart");
		expect(packFor(DEFAULT_SETTINGS)).toBe(true);
		expect(packFor({ ...DEFAULT_SETTINGS, pageBreakAtHeading: "off" })).toBe(false);
		expect(packFor({ ...DEFAULT_SETTINGS, pageBreakAtHeading: "h1" })).toBe(false);
		expect(packFor({ ...DEFAULT_SETTINGS, pageBreakAtHeading: "h2" })).toBe(false);
	});

	it("composes the full send layout from settings — the one truth (GP_E6_S10)", () => {
		expect(sendLayout(DEFAULT_SETTINGS)).toEqual({
			fontSize: 11,
			lineHeight: 1.5,
			margin: 40,
			breakAtHeading: 0,
			packSections: true,
		});
	});

	it("lets a per-send choice override the stored settings via the same path", () => {
		const overridden = sendLayout({
			...DEFAULT_SETTINGS,
			layoutPreset: "compact",
			pageBreakAtHeading: "h1",
		});
		expect(overridden).toMatchObject({
			...LAYOUT_PRESETS.compact,
			breakAtHeading: 1,
			packSections: false,
		});
	});

	it("gives smart to fresh installs only; an upgrade keeps the manual default", () => {
		// No stored data at all: a fresh install, the smart default applies.
		expect(settingsFrom({}).pageBreakAtHeading).toBe("smart");
		// Stored data from before the setting existed: keep the old default,
		// so the upgrade never silently repaginates notes on re-send.
		expect(settingsFrom({ deviceToken: "x" }).pageBreakAtHeading).toBe("off");
		// An explicit choice always wins.
		expect(settingsFrom({ pageBreakAtHeading: "h2" }).pageBreakAtHeading).toBe("h2");
		expect(
			settingsFrom({ deviceToken: "x", pageBreakAtHeading: "smart" }).pageBreakAtHeading,
		).toBe("smart");
		// A data.json holding only unknown extras (the hand-added spike flag)
		// is still a fresh install (reviewvondst 0.35.1).
		expect(
			settingsFrom({ spikeSchrijfmodus: true } as Partial<RoundTripSettings>)
				.pageBreakAtHeading,
		).toBe("smart");
	});
});

describe("notebook canvas migration", () => {
	const legacy = (stored: Record<string, unknown>) =>
		settingsFrom(stored).inkDevice;

	it("turns the old “same as the reMarkable model” into that model", () => {
		expect(legacy({ inkDevice: "auto", deviceModel: "paperpro" })).toBe("paperpro");
		expect(legacy({ inkDevice: "auto", deviceModel: "rm2" })).toBe("rm2");
		expect(legacy({ deviceModel: "paperpro" })).toBe("paperpro");
	});

	it("keeps an explicit canvas", () => {
		expect(legacy({ inkDevice: "move", deviceModel: "paperpro" })).toBe("move");
		expect(legacy({})).toBe("rm2");
	});
});

describe("OCR mode migration", () => {
	it("keeps an OCR endpoint that was switched on, and reads on the device otherwise", () => {
		expect(settingsFrom({ ocrEnabled: true } as Partial<RoundTripSettings>).ocrMode).toBe("endpoint");
		expect(settingsFrom({ ocrEnabled: false } as Partial<RoundTripSettings>).ocrMode).toBe("builtin");
		expect(settingsFrom({}).ocrMode).toBe("builtin");
		expect(settingsFrom({ ocrEnabled: true, ocrMode: "off" } as Partial<RoundTripSettings>).ocrMode).toBe("off");
	});
});
