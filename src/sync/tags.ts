/**
 * A notebook's tags and its note's frontmatter `tags`, kept the same both
 * ways. Each side's tags are compared with the ones both last agreed on (the
 * record's `tags`): a tag added on either side is added, one removed on
 * either side is removed. Sets, so two sides never clash — both adding the
 * same tag adds it once, one removing what the other kept removes it.
 */

/** A frontmatter `tags` value as a list: YAML list or "a, b" / "a b" string, `#` dropped. */
export function frontmatterTags(value: unknown): string[] {
	const raw = Array.isArray(value) ? value.map(String) : typeof value === "string" ? value.split(/[,\s]+/) : [];
	return normalTags(raw);
}

/** Trimmed, without `#`, empty ones and repeats; first occurrence order kept. */
export function normalTags(tags: readonly string[]): string[] {
	const out: string[] = [];
	for (const tag of tags) {
		const name = tag.trim().replace(/^#+/, "");
		if (name !== "" && !out.includes(name)) out.push(name);
	}
	return out;
}

export function sameTags(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((tag) => b.includes(tag));
}

/**
 * The tags both sides end up with. `base` undefined: never synced, both
 * sides' tags count as added. In the vault's order, the tablet's additions
 * after.
 */
export function mergeTags(base: readonly string[] | undefined, vault: readonly string[], tablet: readonly string[]): string[] {
	const was = base ?? [];
	const kept = (tag: string) => (was.includes(tag) ? vault.includes(tag) && tablet.includes(tag) : true);
	return normalTags([...vault, ...tablet]).filter(kept);
}
