/** The WritePad engine, built by scripts/build-writepad.sh (GPL-3.0). */
export interface WritePadModule {
	HEAPU8: Uint8Array;
	HEAP32: Int32Array;
	HEAPF32: Float32Array;
	UTF8ToString(pointer: number): string;
	_malloc(bytes: number): number;
	_free(pointer: number): void;
	_wp_create(language: number, dictPath: number): number;
	_wp_add_word(reco: number, word: number): number;
	_wp_set_dictionary_only(reco: number, only: number): void;
	_wp_recognize(reco: number, xy: number, lengths: number, strokeCount: number, scale: number, flipY: number): number;
	_wp_free(reco: number): void;
}

export default function createWritePad(module?: object): Promise<WritePadModule>;
