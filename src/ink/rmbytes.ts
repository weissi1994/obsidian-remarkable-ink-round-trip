/**
 * The v6 `.rm` tagged-block encoding: header, CRDT ids and a little-endian
 * block writer, after rmscene (MIT, Rick Lupton).
 */

export const HEADER = "reMarkable .lines file, version=6          ";

// Tag nibbles (rmscene TagType).
const TAG_ID = 0xf;
const TAG_LENGTH4 = 0xc;
const TAG_BYTE8 = 0x8;
const TAG_BYTE4 = 0x4;
const TAG_BYTE1 = 0x1;

export interface CrdtId {
	part1: number;
	part2: number;
}

/** Little-endian writer for the v6 tagged-block encoding (shared with the ink writer). */
export class ByteWriter {
	private chunks: number[] = [];

	get length(): number {
		return this.chunks.length;
	}

	bytes(): Uint8Array {
		return Uint8Array.from(this.chunks);
	}

	u8(value: number): void {
		this.chunks.push(value & 0xff);
	}

	u16(value: number): void {
		this.u8(value);
		this.u8(value >>> 8);
	}

	u32(value: number): void {
		this.u16(value & 0xffff);
		this.u16(value >>> 16);
	}

	f32(value: number): void {
		const buf = new DataView(new ArrayBuffer(4));
		buf.setFloat32(0, value, true);
		for (let i = 0; i < 4; i++) this.u8(buf.getUint8(i));
	}

	f64(value: number): void {
		const buf = new DataView(new ArrayBuffer(8));
		buf.setFloat64(0, value, true);
		for (let i = 0; i < 8; i++) this.u8(buf.getUint8(i));
	}

	varuint(value: number): void {
		let v = value >>> 0;
		for (;;) {
			const byte = v & 0x7f;
			v >>>= 7;
			if (v !== 0) {
				this.u8(byte | 0x80);
			} else {
				this.u8(byte);
				break;
			}
		}
	}

	raw(bytes: Uint8Array | number[]): void {
		for (const b of bytes) this.chunks.push(b & 0xff);
	}

	tag(index: number, type: number): void {
		this.varuint((index << 4) | type);
	}

	crdtId(value: CrdtId): void {
		this.u8(value.part1);
		this.varuint(value.part2);
	}

	taggedId(index: number, value: CrdtId): void {
		this.tag(index, TAG_ID);
		this.crdtId(value);
	}

	taggedBool(index: number, value: boolean): void {
		this.tag(index, TAG_BYTE1);
		this.u8(value ? 1 : 0);
	}

	taggedInt(index: number, value: number): void {
		this.tag(index, TAG_BYTE4);
		this.u32(value);
	}

	taggedFloat(index: number, value: number): void {
		this.tag(index, TAG_BYTE4);
		this.f32(value);
	}

	taggedDouble(index: number, value: number): void {
		this.tag(index, TAG_BYTE8);
		this.f64(value);
	}

	/** Nested length-prefixed subblock: tag, uint32 length, payload. */
	subblock(index: number, body: (w: ByteWriter) => void): void {
		const inner = new ByteWriter();
		body(inner);
		this.tag(index, TAG_LENGTH4);
		this.u32(inner.length);
		this.raw(inner.bytes());
	}

	taggedString(index: number, value: string): void {
		const encoded = new TextEncoder().encode(value);
		this.subblock(index, (w) => {
			w.varuint(encoded.length);
			w.u8(1); // "is ascii" flag; rmscene always writes true.
			w.raw(encoded);
		});
	}

	lwwString(index: number, timestamp: CrdtId, value: string): void {
		this.subblock(index, (w) => {
			w.taggedId(1, timestamp);
			w.taggedString(2, value);
		});
	}

	lwwBool(index: number, timestamp: CrdtId, value: boolean): void {
		this.subblock(index, (w) => {
			w.taggedId(1, timestamp);
			w.taggedBool(2, value);
		});
	}

	/** Top-level block envelope: length, 0, minVersion, currentVersion, type. */
	block(type: number, minVersion: number, currentVersion: number, body: (w: ByteWriter) => void): void {
		const inner = new ByteWriter();
		body(inner);
		this.u32(inner.length);
		this.u8(0);
		this.u8(minVersion);
		this.u8(currentVersion);
		this.u8(type);
		this.raw(inner.bytes());
	}
}
