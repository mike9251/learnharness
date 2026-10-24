import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { scrollWithinDock, useDockHeight } from "../components/use-dock-height.ts";
import { QuestionDock } from "../components/question-dock.tsx";
import { PracticeDock } from "../components/practice-dock.tsx";

const dom = parseHTML("<html><body></body></html>");
let budget = 400;
let controlHeight = 150;
let observer: TestResizeObserver;
class TestResizeObserver {
	observed: Element[] = [];
	disconnected = false;
	constructor(public callback: () => void) { observer = this; }
	observe(element: Element) { this.observed.push(element); }
	disconnect() { this.disconnected = true; }
}
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	HTMLElement: dom.window.HTMLElement,
	IS_REACT_ACT_ENVIRONMENT: true,
	ResizeObserver: TestResizeObserver,
	getComputedStyle: (element: HTMLElement) => ({
		maxHeight: `${budget}px`,
		marginTop: element.hasAttribute("data-controls") ? "6px" : "0px",
		marginBottom: element.hasAttribute("data-controls") ? "6px" : "0px",
		paddingTop: element.hasAttribute("data-area") ? "12px" : "0px",
		paddingBottom: element.hasAttribute("data-area") ? "8px" : "0px",
		borderTopWidth: "0px",
		borderBottomWidth: "0px",
		lineHeight: element.classList.contains("lh-prose") ? "24px" : "20px",
	}),
});
let root: Root | undefined;
function Harness({ active = true }: { active?: boolean }) {
	const { rootRef, scrollRef, surfaceStyle } = useDockHeight(active, "40vh");
	return active ? <div ref={rootRef} style={surfaceStyle} data-surface="">
		<div ref={scrollRef} data-area=""><div className="lh-prose">Question</div></div>
		<div data-controls="" ref={(node) => {
			if (node) node.getBoundingClientRect = () => ({ height: controlHeight }) as DOMRect;
		}}>Thinking and submit</div>
	</div> : <button>Expand</button>;
}
async function mount(active = true) {
	if (!root) {
		const host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
	}
	await act(async () => root!.render(<Harness active={active} />));
}
const area = () => document.querySelector<HTMLElement>("[data-area]")!;
afterEach(async () => {
	await act(async () => root?.unmount());
	root = undefined;
	document.body.innerHTML = "";
	budget = 400;
	controlHeight = 150;
});

describe("whole-form dock budget", () => {
	it("subtracts controls INCLUDING margins; observes root and controls, not growing question content", async () => {
		await mount();
		assert.equal(area().style.maxHeight, "max(0px, calc(var(--dock-max-h, 40vh) - 162px))");
		assert.equal(observer.observed.length, 2);
		assert.ok(!observer.observed.includes(area()));
		controlHeight = 180;
		observer.callback();
		assert.equal(area().style.maxHeight, "max(0px, calc(var(--dock-max-h, 40vh) - 192px))");
	});

	it("keeps ALL question content reachable via root fallback in tiny sessions, then recovers", async () => {
		budget = 100;
		await mount();
		assert.equal(area().style.maxHeight, "none");
		assert.equal(area().style.overflowY, "visible", "wheel events must reach the root fallback scroller");
		assert.equal(area().style.overscrollBehaviorY, "auto");
		budget = 182; // controls + margins + question padding, exactly
		observer.callback();
		assert.equal(area().style.maxHeight, "none");
		budget = 198; // 16px after controls and padding: less than the 24px prose line
		observer.callback();
		assert.equal(area().style.maxHeight, "none", "a text sliver uses whole-form scrolling too");
		budget = 206; // controls + margins + padding + exactly one prose line
		observer.callback();
		assert.equal(area().style.maxHeight, "max(0px, calc(var(--dock-max-h, 40vh) - 162px))");
		assert.equal(area().style.overflowY, "", "normal question scrolling resumes through its CSS classes");
		assert.equal(area().style.overscrollBehaviorY, "");
	});

	it("reconnects after collapse/expand and releases observation on unmount", async () => {
		await mount(false);
		await mount(true);
		const first = observer;
		await mount(false);
		assert.ok(first.disconnected);
		await mount(true);
		assert.notEqual(observer, first);
		assert.ok(area().style.maxHeight);
	});
});

describe("dock-only keyboard scrolling", () => {
	function box(top: number, bottom: number) {
		const element = document.createElement("div");
		element.getBoundingClientRect = () => ({ top, bottom }) as DOMRect;
		Object.assign(element, { scrollTop: 0, clientTop: 0, clientHeight: bottom - top, scrollHeight: 1000 });
		element.scrollIntoView = () => { throw new Error("must not scroll transcript ancestors"); };
		return element;
	}
	it("moves only the question scroller to expose a lower or upper walked row", () => {
		const scroller = box(100, 300);
		scrollWithinDock(box(320, 360), scroller);
		assert.equal(scroller.scrollTop, 60);
		scrollWithinDock(box(80, 120), scroller);
		assert.equal(scroller.scrollTop, 40);
	});
	it("does not move an already visible row or one spanning the viewport", () => {
		const scroller = box(100, 300);
		scrollWithinDock(box(140, 180), scroller);
		scrollWithinDock(box(80, 400), scroller);
		assert.equal(scroller.scrollTop, 0);
	});
});

describe("fixed dock fields and wheel boundaries", () => {
	const quiz = { question: "Which?", options: [{ label: "A" }, { label: "B" }], correctAnswer: "A", explanation: "Because." };
	for (const phase of ["probe", "teach"] as const) {
		it(`${phase} quiz keeps its initial field height`, () => {
			const html = renderToStaticMarkup(<QuestionDock toolName="quiz" toolCallId="q" input={quiz} phase={phase} expanded onExpand={() => {}} onSubmit={() => {}} />);
			assertField(html, phase === "teach" ? "h-[4.5rem]" : "h-10");
		});
	}
	it("text-answer stays 40px", () => {
		assertField(renderToStaticMarkup(<QuestionDock toolName="ask_user_question" toolCallId="a" input={{ question: "Why?" }} expanded onExpand={() => {}} onSubmit={() => {}} />), "h-10");
	});
	it("practice thinking stays 64px", () => {
		assertField(renderToStaticMarkup(<PracticeDock problemCallId="p" input={{ statement: "Prove it." }} expanded onExpand={() => {}} onSubmit={() => {}} />), "h-16");
	});
	function assertField(html: string, height: string) {
		const doc = parseHTML(html).document;
		const surface = doc.querySelector("[data-dock-surface]")!;
		const question = doc.querySelector("[data-dock-scroll-area]")!;
		const field = doc.querySelector("textarea")!;
		assert.match(surface.getAttribute("style")!, /max-height:var\(--dock-max-h/);
		for (const element of [surface, question, field]) {
			assert.ok(element.classList.contains("overflow-y-auto"));
			assert.ok(element.classList.contains("overscroll-contain"));
		}
		assert.ok(field.classList.contains(height));
		assert.ok(!field.classList.contains("field-sizing-content"));
		assert.ok(!field.className.includes("min-h-"));
	}
});
