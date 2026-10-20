/**
 * The Mermaid look a handwritten diagram is drawn from (ink fork).
 *
 * The diagram is rendered once at send time, then traced into strokes, so
 * what matters is what reads well in pen: black lines and text on white
 * shapes (whatever Obsidian's own theme is — a dark theme would hand back
 * light-on-dark geometry), a pale-yellow note colour, and saturated chart
 * colours that land cleanly on the tablet's inks when they are hatched.
 * Labels as SVG text rather than HTML, so the tracer can measure them.
 */

export const MERMAID_THEME_VARIABLES: Record<string, string> = {
	"background": "#ffffff",
	"primaryColor": "#ffffff",
	"primaryTextColor": "#000000",
	"primaryBorderColor": "#000000",
	"secondaryColor": "#ffffff",
	"tertiaryColor": "#ffffff",
	"lineColor": "#000000",
	"textColor": "#000000",
	"mainBkg": "#ffffff",
	"nodeBorder": "#000000",
	"clusterBkg": "#ffffff",
	"clusterBorder": "#000000",
	"edgeLabelBackground": "#ffffff",
	"noteBkgColor": "#fff3a8",
	"noteTextColor": "#000000",
	"noteBorderColor": "#000000",
	"actorBkg": "#ffffff",
	"actorBorder": "#000000",
	"actorTextColor": "#000000",
	"signalColor": "#000000",
	"signalTextColor": "#000000",
	"labelBoxBkgColor": "#ffffff",
	"labelBoxBorderColor": "#000000",
	"activationBkgColor": "#e6e6e6",
	"sequenceNumberColor": "#ffffff",
	"pie1": "#3f6fd8",
	"pie2": "#d83f3f",
	"pie3": "#3fa857",
	"pie4": "#f0c828",
	"pie5": "#e055aa",
	"pie6": "#8c8c8c",
	"pie7": "#7fa6f0",
	"pie8": "#f08a8a",
	"pie9": "#8fd19c",
	"pie10": "#f7e08a",
	"pie11": "#f2a3d3",
	"pie12": "#444444",
	"pieStrokeColor": "#000000",
	"pieOuterStrokeColor": "#000000",
	"pieTitleTextColor": "#000000",
	"pieSectionTextColor": "#000000",
	"pieLegendTextColor": "#000000",
	"taskBkgColor": "#9db8f0",
	"taskBorderColor": "#000000",
	"activeTaskBkgColor": "#f7e08a",
	"activeTaskBorderColor": "#000000",
	"doneTaskBkgColor": "#bdbdbd",
	"doneTaskBorderColor": "#000000",
	"critBkgColor": "#f08a8a",
	"critBorderColor": "#000000",
	"sectionBkgColor": "#ffffff",
	"altSectionBkgColor": "#ffffff",
	"sectionBkgColor2": "#ffffff",
	"gridColor": "#cccccc",
	"todayLineColor": "#d83f3f",
	"git0": "#3f6fd8",
	"git1": "#d83f3f",
	"git2": "#3fa857",
	"git3": "#f0c828",
};

const INIT = {
	theme: "base",
	themeVariables: MERMAID_THEME_VARIABLES,
	htmlLabels: false,
	flowchart: { htmlLabels: false },
	class: { htmlLabels: false },
	state: { htmlLabels: false },
};

/**
 * The diagram source with our directive in front — after a YAML front
 * matter block if the diagram has one, since that must stay first. A
 * directive of the diagram's own, later in the source, still wins.
 */
export function withInkTheme(source: string): string {
	const directive = `%%{init: ${JSON.stringify(INIT)}}%%`;
	const front = /^\s*---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(source);
	if (front !== null) return `${front[0]}${directive}\n${source.slice(front[0].length)}`;
	return `${directive}\n${source}`;
}

/** A line's quote depth and its text inside at most `max` quote levels. */
function unquote(line: string, max = Infinity): { depth: number; inner: string } {
	let depth = 0;
	let inner = line;
	while (depth < max && /^\s*>/.test(inner)) {
		inner = inner.replace(/^\s*>\s?/, "");
		depth++;
	}
	return { depth, inner };
}

/**
 * Mermaid fenced blocks in markdown, as parseBlocks will see their source —
 * at the top level or inside a quote or callout, at any depth, with the
 * quote markers stripped as the nested-quote parse strips them.
 */
export function mermaidBlocks(markdown: string): string[] {
	const out: string[] = [];
	const lines = markdown.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const { depth, inner } = unquote(lines[i]);
		if (!/^\s*(```|~~~)\s*mermaid\b/.test(inner)) continue;
		const code: string[] = [];
		i++;
		while (i < lines.length) {
			const line = unquote(lines[i], depth);
			// The quote ended, and the fence with it; that line is the outer loop's.
			if (line.depth < depth) {
				i--;
				break;
			}
			if (/^\s*(```|~~~)/.test(line.inner)) break;
			code.push(line.inner);
			i++;
		}
		out.push(code.join("\n"));
	}
	return out;
}
