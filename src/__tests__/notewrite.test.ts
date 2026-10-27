import { describe, expect, it } from "vitest";
import { mergeIntoNote, type NoteFileIo } from "../sync/notewrite";

/** A note in the vault; `process` is atomic, like Vault.process. */
function vaultNote(initial: string) {
	let text = initial;
	const io: NoteFileIo = {
		read: async () => text,
		process: async (change) => {
			text = change(text);
			return text;
		},
	};
	return {
		io,
		text: () => text,
		type: (more: string) => {
			text += more;
		},
	};
}

/** Tablet ink merged in: a remark appended under the note. */
const addRemark = (current: string) => ({ text: `${current}\n> [!note] From the tablet`, result: "merged" });

describe("writing tablet changes into a note", () => {
	it("keeps what was typed while the merge was being prepared", async () => {
		const note = vaultNote("Shopping list");
		const backups: string[] = [];
		const { written } = await mergeIntoNote(
			note.io,
			async (preImage) => {
				backups.push(preImage);
				// The owner keeps typing while the backup is written.
				if (backups.length === 1) note.type("\nmilk");
			},
			addRemark,
		);
		expect(written).toBe(true);
		expect(note.text()).toBe("Shopping list\nmilk\n> [!note] From the tablet");
		// The backup ends up holding exactly the text that was replaced.
		expect(backups[backups.length - 1]).toBe("Shopping list\nmilk");
	});

	it("backs up the note before touching it", async () => {
		const note = vaultNote("Plan");
		const order: string[] = [];
		await mergeIntoNote(
			{
				read: () => note.io.read(),
				process: (change) => {
					order.push("write");
					return note.io.process(change);
				},
			},
			async (preImage) => {
				order.push(`backup:${preImage}`);
			},
			addRemark,
		);
		expect(order).toEqual(["backup:Plan", "write"]);
	});

	it("writes nothing, not even a backup, when nothing changes", async () => {
		const note = vaultNote("Plan");
		let backups = 0;
		let writes = 0;
		const { written, result } = await mergeIntoNote(
			{
				read: () => note.io.read(),
				process: (change) => {
					writes++;
					return note.io.process(change);
				},
			},
			async () => {
				backups++;
			},
			(current) => ({ text: current, result: "nothing new" }),
		);
		expect({ written, result, backups, writes }).toEqual({ written: false, result: "nothing new", backups: 0, writes: 0 });
	});
});
