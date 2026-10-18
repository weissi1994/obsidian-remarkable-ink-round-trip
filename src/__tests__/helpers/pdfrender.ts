/**
 * The typesetter on pdf-lib's standard fonts, for tests only: the plugin no
 * longer writes PDFs, but these metrics are what the layout tests were
 * written against.
 */

import { PDFDocument, PDFFont, PDFImage, PDFPage, StandardFonts, rgb } from "pdf-lib";
import type { Block } from "../../convert/mdblocks";
import {
	DrawColor,
	MeasureFont,
	PdfLayout,
	PdfLayoutOptions,
	TypesetBackend,
	typesetBlocks,
} from "../../convert/pdf";

export interface PdfMetadata {
	title: string;
	docId: string;
}

export const DOCID_SUBJECT_PREFIX = "remarkable-round-trip:docid:";

export interface PdfRender {
	bytes: Uint8Array;
	layout: PdfLayout;
}

export async function renderPdf(
	blocks: Block[],
	meta: PdfMetadata,
	options: PdfLayoutOptions = {},
): Promise<PdfRender> {
	const doc = await PDFDocument.create();
	doc.setTitle(meta.title);
	doc.setSubject(`${DOCID_SUBJECT_PREFIX}${meta.docId}`);
	const fonts = {
		body: await doc.embedFont(StandardFonts.Helvetica),
		bold: await doc.embedFont(StandardFonts.HelveticaBold),
		italic: await doc.embedFont(StandardFonts.HelveticaOblique),
		mono: await doc.embedFont(StandardFonts.Courier),
	};
	const embedded = new Map<Block, PDFImage>();
	for (const block of blocks) {
		if (block.type === "image" && block.png !== undefined) {
			embedded.set(block, await doc.embedPng(block.png));
		}
	}
	const layout = typesetBlocks(blocks, meta.title, options, pdfBackend(doc, fonts, embedded));
	return { bytes: await doc.save(), layout };
}

function pdfBackend(
	doc: PDFDocument,
	fonts: { body: PDFFont; bold: PDFFont; italic: PDFFont; mono: PDFFont },
	embedded: Map<Block, PDFImage>,
): TypesetBackend {
	const asPdfFont = (font: MeasureFont) => font as PDFFont;
	const color = (c: DrawColor | undefined) => (c === undefined ? undefined : rgb(c.red, c.green, c.blue));
	return {
		...fonts,
		addPage(width, height) {
			const page: PDFPage = doc.addPage([width, height]);
			return {
				drawText: (text, o) => page.drawText(text, { ...o, font: asPdfFont(o.font), color: color(o.color) }),
				drawLine: (o) => page.drawLine({ ...o, color: color(o.color) }),
				drawRectangle: (o) => page.drawRectangle({ ...o, borderColor: color(o.borderColor) }),
				drawPng: (block, o) => {
					const handle = embedded.get(block);
					if (handle !== undefined) page.drawImage(handle, o);
				},
			};
		},
	};
}
