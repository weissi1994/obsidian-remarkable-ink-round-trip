/*
 * A small C interface over the WritePad handwriting recognition engine
 * (vendor/writepad, GPL-3.0), for the plugin's WebAssembly build and a native
 * test tool. Strokes in, words with their alternatives and weights out, as
 * JSON — the plugin decides between languages and against the vault's words.
 *
 * Part of reMarkable Ink Round-Trip, GPL-3.0-or-later.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <string>
#include <vector>
#include <algorithm>

#include "InkWrapper.h"
#include "RecognizerWrapper.h"

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#define WP_EXPORT extern "C" EMSCRIPTEN_KEEPALIVE
#else
#define WP_EXPORT extern "C"
#endif

static std::string g_result;
static int g_dictionaryOnly = 0;

/** Engine text — 16-bit code units (HW_RECINT_UNICODE) — as a JSON string literal. */
static void appendJsonString(std::string &out, const UCHR *text) {
	out += '"';
	for (const UCHR *p = text; *p != 0; p++) {
		unsigned int c = (unsigned int)*p;
		if (c == '"' || c == '\\') {
			out += '\\';
			out += (char)c;
		} else if (c < 0x20 || c >= 0x80) {
			char buf[8];
			snprintf(buf, sizeof buf, "\\u%04x", c & 0xffff);
			out += buf;
		} else {
			out += (char)c;
		}
	}
	out += '"';
}

/**
 * A recogniser for one language (1 = English, 3 = German), its main
 * dictionary read from `dictPath`. Returns null when the language is not
 * built in.
 */
WP_EXPORT void *wp_create(int language, const char *dictPath) {
	int flags = 0;
	// As the engine's own sample does: user dictionary, learner and corrector
	// named, even though none of them exists yet.
	RECOGNIZER_PTR reco = HWR_InitRecognizer(dictPath, "/tmp/wp_user.dct", "/tmp/wp_stat.lrn", "/tmp/wp_corr.cwl", language, &flags);
	if (reco == NULL) return NULL;
	unsigned int f = HWR_GetRecognitionFlags(reco);
	f &= ~(FLAG_SINGLEWORDONLY | FLAG_ONLYDICT | FLAG_SEPLET | FLAG_SMOOTHSTROKES);
	HWR_SetRecognitionFlags(reco, f);
	return reco;
}

/** Add a word (16-bit code units, zero-terminated) to the recogniser's user dictionary. */
WP_EXPORT int wp_add_word(void *reco, const UCHR *word) {
	return HWR_AddUserWordToDict((RECOGNIZER_PTR)reco, word, false) ? 1 : 0;
}

/** Only words from the dictionaries (1) or any letter sequence (0). */
WP_EXPORT void wp_set_dictionary_only(void *reco, int only) {
	(void)reco;
	g_dictionaryOnly = only;
}

/**
 * Recognise strokes: `xy` holds x,y pairs, `lengths` the number of points of
 * each of `strokeCount` strokes, y pointing down; `scale` <= 0 sizes the
 * ink automatically. Returns JSON — an array of
 * words, each an array of [text, weight] alternatives, best first — valid
 * until the next call.
 */
WP_EXPORT const char *wp_recognize(void *reco, const float *xy, const int *lengths, int strokeCount, float scale, int flipY) {
	RECOGNIZER_PTR r = (RECOGNIZER_PTR)reco;
	int total = 0;
	for (int s = 0; s < strokeCount; s++) total += lengths[s];
	if (total == 0) return "[]";
	// The engine was tuned on screen handwriting: ink from the origin, strokes
	// around 55 units tall. `scale` <= 0 picks the scale that gets there.
	float minX = xy[0], minY = xy[1];
	for (int i = 0; i < total; i++) {
		if (xy[i * 2] < minX) minX = xy[i * 2];
		if (xy[i * 2 + 1] < minY) minY = xy[i * 2 + 1];
	}
	if (scale <= 0) {
		std::vector<float> heights;
		int at = 0;
		for (int s = 0; s < strokeCount; s++) {
			float lo = 1e9f, hi = -1e9f;
			for (int i = 0; i < lengths[s]; i++, at++) {
				float y = xy[at * 2 + 1];
				if (y < lo) lo = y;
				if (y > hi) hi = y;
			}
			if (lengths[s] > 0) heights.push_back(hi - lo);
		}
		std::sort(heights.begin(), heights.end());
		float median = heights.empty() ? 0 : heights[heights.size() / 2];
		scale = median > 1 ? 55.0f / median : 1.0f;
	}
	INK_DATA_PTR ink = INK_InitData();
	int at = 0;
	for (int s = 0; s < strokeCount; s++) {
		int stroke = INK_AddEmptyStroke(ink, 3.0f, 0);
		float px = 0, py = 0;
		for (int i = 0; i < lengths[s]; i++, at++) {
			float x = 1 + (xy[at * 2] - minX) * scale;
			float y = 1 + (xy[at * 2 + 1] - minY) * scale;
			if (i > 0) {
				// The engine reads near-continuous traces, as a screen samples
				// them: no two points more than ~2 units apart.
				float d = fabsf(x - px) + fabsf(y - py);
				if (d < 1.0f) continue;
				int steps = (int)(d / 2.0f);
				for (int k = 1; k < steps; k++) {
					float t = (float)k / steps;
					INK_AddPixelToStroke(ink, stroke, px + (x - px) * t, py + (y - py) * t, 127);
				}
			}
			INK_AddPixelToStroke(ink, stroke, x, y, 127);
			px = x;
			py = y;
		}
	}
	// As the engine's sample does: settle every stroke (its bounds) first.
	for (int s = 0; s < INK_StrokeCount(ink, false); s++) {
		CGRect rect;
		INK_MoveStroke(ink, s, 0, 0, &rect, false);
	}
	HWR_Reset(r);
	// Flags are applied after a reset, as the engine's sample does.
	unsigned int f = HWR_GetRecognitionFlags(r);
	f &= ~(FLAG_SINGLEWORDONLY | FLAG_SMOOTHSTROKES | FLAG_SEPLET);
	f = g_dictionaryOnly ? (f | FLAG_ONLYDICT) : (f & ~FLAG_ONLYDICT);
	HWR_SetRecognitionFlags(r, f);
	const UCHR *text = HWR_RecognizeInkData(r, ink, 0, -1, true, flipY != 0, false, false);
	g_result = "[";
	if (text != NULL && *text != 0) {
		int words = HWR_GetResultWordCount(r);
		for (int w = 0; w < words; w++) {
			if (w > 0) g_result += ',';
			g_result += '[';
			int alts = HWR_GetResultAlternativeCount(r, w);
			for (int a = 0; a < alts; a++) {
				const UCHR *word = HWR_GetResultWord(r, w, a);
				if (word == NULL) continue;
				if (a > 0) g_result += ',';
				g_result += '[';
				appendJsonString(g_result, word);
				g_result += ',';
				g_result += std::to_string(HWR_GetResultWeight(r, w, a));
				g_result += ']';
			}
			g_result += ']';
		}
	}
	g_result += ']';
	INK_FreeData(ink);
	return g_result.c_str();
}

WP_EXPORT void wp_free(void *reco) {
	HWR_FreeRecognizer((RECOGNIZER_PTR)reco, NULL, NULL, NULL);
}

#ifdef WP_TEST_MAIN
/*
 * Native test tool: wp_test <language> <dictionary> < strokes
 * Strokes as lines "x y", a blank line between strokes.
 */
int main(int argc, char **argv) {
	if (argc < 3) {
		fprintf(stderr, "usage: wp_test <language> <dictionary> < strokes\n");
		return 1;
	}
	void *reco = wp_create(atoi(argv[1]), argv[2]);
	if (reco == NULL) {
		fprintf(stderr, "language not supported\n");
		return 1;
	}
	for (int i = 3; i < argc; i++) {
		UCHR word[256];
		size_t n = 0;
		for (const unsigned char *p = (const unsigned char *)argv[i]; *p && n < 255; p++) word[n++] = *p;
		word[n] = 0;
		if (!wp_add_word(reco, word)) fprintf(stderr, "not added: %s\n", argv[i]);
	}
	std::string line;
	float *xy = (float *)malloc(sizeof(float) * 2 * 200000);
	int *lengths = (int *)malloc(sizeof(int) * 10000);
	int points = 0, strokes = 0, current = 0;
	char buf[256];
	while (fgets(buf, sizeof buf, stdin) != NULL) {
		float x, y;
		if (sscanf(buf, "%f %f", &x, &y) == 2) {
			xy[points * 2] = x;
			xy[points * 2 + 1] = y;
			points++;
			current++;
		} else if (current > 0) {
			lengths[strokes++] = current;
			current = 0;
		}
	}
	if (current > 0) lengths[strokes++] = current;
	if (getenv("WP_ONLYDICT") != NULL) wp_set_dictionary_only(reco, 1);
	const char *scale = getenv("WP_SCALE");
	const char *flip = getenv("WP_FLIP");
	printf("%s\n", wp_recognize(reco, xy, lengths, strokes, scale ? (float)atof(scale) : 0.0f, flip ? atoi(flip) : 0));
	wp_free(reco);
	return 0;
}
#endif
