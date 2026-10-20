/**
 * Test stand-in for the "obsidian" module, which ships types only (the real
 * API exists inside the app). Just the pieces UI code under test touches;
 * vitest.config.ts points "obsidian" here.
 */

const HTML = "http://www.w3.org/1999/xhtml";
/** A bare element — what Obsidian's createEl builds on. */
const make = <K extends keyof HTMLElementTagNameMap>(tag: K) => document.createElementNS(HTML, tag) as HTMLElementTagNameMap[K];

export function setIcon(el: HTMLElement, icon: string): void {
	el.setAttribute("data-icon", icon);
}

export class Modal {
	contentEl = make("div");
	constructor(public app: unknown) {}
	setTitle(): this {
		return this;
	}
	open(): void {}
	close(): void {}
}

export class ButtonComponent {
	buttonEl: HTMLButtonElement;
	constructor(parent: HTMLElement) {
		this.buttonEl = parent.appendChild(make("button"));
	}
	setButtonText(text: string): this {
		this.buttonEl.textContent = text;
		return this;
	}
	setCta(): this {
		return this;
	}
	onClick(handler: () => void): this {
		this.buttonEl.addEventListener("click", handler);
		return this;
	}
}

export class TFile {}

export class MarkdownView {}

export class MarkdownRenderChild {
	constructor(public containerEl: HTMLElement) {}
	onload(): void {}
	onunload(): void {}
	load(): void {
		this.onload();
	}
	unload(): void {
		this.onunload();
	}
}

/** The editor's file info field: a key only, the editor parts are not under test. */
export const editorInfoField = {};

/** Obsidian's DOM helpers on HTMLElement (createEl, createDiv), for a DOM test environment. */
export function installDomHelpers(): void {
	type Options = { cls?: string; attr?: Record<string, string>; text?: string };
	const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
	proto.createEl = function (this: HTMLElement, tag: string, o: Options = {}) {
		const el = make(tag as keyof HTMLElementTagNameMap);
		if (o.cls !== undefined) el.className = o.cls;
		for (const [k, v] of Object.entries(o.attr ?? {})) el.setAttribute(k, v);
		if (o.text !== undefined) el.textContent = o.text;
		this.appendChild(el);
		return el;
	};
	proto.createDiv = function (this: HTMLElement, o: Options = {}) {
		return (proto.createEl as (this: HTMLElement, tag: string, o: Options) => HTMLElement).call(this, "div", o);
	};
	proto.createSpan = function (this: HTMLElement, o: Options = {}) {
		return (proto.createEl as (this: HTMLElement, tag: string, o: Options) => HTMLElement).call(this, "span", o);
	};
	proto.addClass = function (this: HTMLElement, cls: string) {
		this.classList.add(cls);
	};
	proto.removeClass = function (this: HTMLElement, cls: string) {
		this.classList.remove(cls);
	};
	proto.setCssProps = function (this: HTMLElement, props: Record<string, string>) {
		for (const [k, v] of Object.entries(props)) this.style.setProperty(k, v);
	};
	// And the global forms, for building fixtures.
	const global = globalThis as unknown as Record<string, unknown>;
	global.createEl = (tag: string, o: Options = {}) => {
		const host = make("div");
		const el = (proto.createEl as (this: HTMLElement, tag: string, o: Options) => HTMLElement).call(host, tag, o);
		el.remove();
		return el;
	};
	global.createDiv = (o: Options = {}) => (global.createEl as (tag: string, o: Options) => HTMLElement)("div", o);
	proto.empty = function (this: HTMLElement) {
		this.replaceChildren();
	};
}
