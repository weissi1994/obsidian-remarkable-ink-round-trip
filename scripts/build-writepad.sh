#!/usr/bin/env bash
# Build the WritePad handwriting engine (vendor/writepad, GPL-3.0) with the
# plugin's bridge (native/writepad):
#   scripts/build-writepad.sh native   → build/writepad/wp_test (test tool)
#   scripts/build-writepad.sh wasm     → src/ocr/writepad/engine.js (committed)
# English and German only. The wasm build needs Emscripten; without it on the
# PATH it runs inside `nix-shell -p emscripten`.
set -euo pipefail
cd "$(dirname "$0")/.."

target="${1:-wasm}"
V300=vendor/writepad/UniversalRecognizer/V300
if [ ! -d "$V300" ]; then
	echo "vendor/writepad is missing: run git submodule update --init" >&2
	exit 1
fi

# The engine's own source list, from its Linux makefile.
mapfile -t names < <(sed -n '/^SRCS :=/,/^$/p' vendor/writepad/Linux/makefile | grep -o '[A-Za-z0-9_]*\.cpp')
sources=()
for name in "${names[@]}"; do
	for dir in RecognizerWrapper InkData reco/src reco/data; do
		if [ -f "$V300/$dir/$name" ]; then
			sources+=("$V300/$dir/$name")
			break
		fi
	done
done

flags=(
	-std=gnu++11 -O2 -w
	-I"$V300/include" -I"$V300/InkData" -I"$V300/reco/include" -I"$V300/reco/data" -I"$V300/RecognizerWrapper"
	-D_OS_LINUX -DHWR_SYSTEM=HWR_LINUX -D_EMBEDDED_DEVICE -DRECODICT
	-DLANG_ENGLISH -DLANG_GERMAN
)

out=build/writepad
mkdir -p "$out/src"

# The engine reads on a thread of its own outside Windows; WebAssembly here
# has no threads, so build its synchronous (Windows) path everywhere.
sed '/^#define INTERNAL_RECO_THREAD/d' "$V300/RecognizerWrapper/RecognizerWrapper.cpp" > "$out/src/RecognizerWrapper.cpp"
for i in "${!sources[@]}"; do
	[ "$(basename "${sources[$i]}")" = RecognizerWrapper.cpp ] && sources[$i]="$out/src/RecognizerWrapper.cpp"
done

if [ "$target" = native ]; then
	g++ "${flags[@]}" -DWP_TEST_MAIN native/writepad/wp_bridge.cpp "${sources[@]}" -lpthread -o "$out/wp_test"
	echo "$out/wp_test"
	exit 0
fi

if ! command -v em++ >/dev/null; then
	exec nix-shell -p emscripten --run "$0 wasm"
fi

mkdir -p "$out/dict" src/ocr/writepad
cp vendor/writepad/Dictionaries/English.dct vendor/writepad/Dictionaries/German.dct "$out/dict/"
em++ "${flags[@]}" -Oz native/writepad/wp_bridge.cpp "${sources[@]}" \
	-sMODULARIZE=1 -sEXPORT_NAME=createWritePad -sEXPORT_ES6=1 -sENVIRONMENT=web \
	-sSINGLE_FILE=1 -sSINGLE_FILE_BINARY_ENCODE=0 -sDYNAMIC_EXECUTION=0 -sALLOW_MEMORY_GROWTH=1 -sFILESYSTEM=1 \
	-sEXPORTED_FUNCTIONS=_wp_create,_wp_add_word,_wp_set_dictionary_only,_wp_recognize,_wp_free,_malloc,_free \
	-sEXPORTED_RUNTIME_METHODS=UTF8ToString,HEAPF32,HEAP32,HEAPU8 \
	--embed-file "$out/dict@/dict" \
	-o src/ocr/writepad/engine.js
# Everything is embedded (SINGLE_FILE, as base64: raw bytes would come out
# of esbuild escaped to several times their size), so the script's own URL is never
# needed — and the plugin bundle is CommonJS, where import.meta does not exist.
sed -i 's/import\.meta\.url/""/g' src/ocr/writepad/engine.js
echo "src/ocr/writepad/engine.js ($(du -h src/ocr/writepad/engine.js | cut -f1))"
