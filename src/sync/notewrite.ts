/**
 * Writing merged tablet changes into a note without losing what the owner
 * typed meanwhile (ink fork).
 *
 * Reading the note, preparing the merge and keeping a backup all take time;
 * a plain read-then-overwrite would drop every keystroke made in between. So
 * the merge runs again inside the vault's atomic read-modify-write, against
 * the note as it is at that moment, and the backup ends up holding exactly
 * the text that was replaced.
 */

/** The vault seam: the edge adapts Vault.read / Vault.process for one file. */
export interface NoteFileIo {
	read(): Promise<string>;
	/** Atomic: `change` gets the note as it is now, its result is written. */
	process(change: (current: string) => string): Promise<string>;
}

/**
 * Merge into the note: `merge` maps a note's full text to the new text
 * (synchronous, so it can run inside `process`). The backup is written
 * before the note is touched, and again when the note changed in between,
 * so it always holds the replaced text. Nothing is written when the merge
 * changes nothing.
 */
export async function mergeIntoNote<T>(
	io: NoteFileIo,
	backup: (preImage: string) => Promise<void>,
	merge: (current: string) => { text: string; result: T },
): Promise<{ written: boolean; result: T; text: string }> {
	const read = await io.read();
	const first = merge(read);
	if (first.text === read) return { written: false, result: first.result, text: read };
	await backup(read);
	let replaced = read;
	let last = first;
	await io.process((current) => {
		replaced = current;
		last = current === read ? first : merge(current);
		return last.text;
	});
	if (replaced !== read) await backup(replaced);
	return { written: last.text !== replaced, result: last.result, text: last.text };
}
