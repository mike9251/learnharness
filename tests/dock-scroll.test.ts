import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { dockFormHeight, routeDockWheel } from "../components/dock-scroll.ts";

const { window } = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	Element: window.Element,
	HTMLElement: window.HTMLElement,
	getComputedStyle: (element: HTMLElement) => ({ overflowY: element.style.overflowY || "visible" }),
});

function fixture(protectedPanel = true) {
	const root = window.document.createElement("div");
	const panel = window.document.createElement("div");
	const area = window.document.createElement("div");
	const child = window.document.createElement("span");
	root.append(panel); panel.append(area); area.append(child);
	if (protectedPanel) panel.setAttribute("data-dock-surface", "");
	area.style.overflowY = "auto";
	Object.defineProperties(area, { clientHeight: { value: 200 }, scrollHeight: { value: 800 } });
	area.scrollTop = 0;
	const transcript = window.document.createElement("div");
	Object.defineProperty(transcript, "clientHeight", { value: 600 });
	transcript.scrollTop = 1000;
	return { root, panel, area, child, transcript };
}

function wheel(target: Element, deltaY: number, deltaMode = 0, ctrlKey = false) {
	let prevented = false;
	const event = {
		target, deltaY, deltaMode, ctrlKey,
		get defaultPrevented() { return prevented; },
		preventDefault() { prevented = true; },
	} as unknown as WheelEvent;
	return event;
}

describe("expanded dock wheel ownership", () => {
	it("keeps question top and bottom overscroll out of the transcript", () => {
		const f = fixture();
		for (const [position, delta] of [[0, -180], [600, 180]]) {
			f.area.scrollTop = position!;
			const e = wheel(f.child, delta!);
			routeDockWheel(e, f.root, f.transcript);
			assert.equal(e.defaultPrevented, true);
			assert.equal(f.transcript.scrollTop, 1000);
		}
	});
	it("leaves native scrolling alone inside the question and thinking textarea", () => {
		const f = fixture();
		f.area.scrollTop = 100;
		for (const delta of [-40, 40]) {
			const e = wheel(f.child, delta);
			routeDockWheel(e, f.root, f.transcript);
			assert.equal(e.defaultPrevented, false);
		}
		const textarea = window.document.createElement("textarea");
		textarea.style.overflowY = "auto";
		Object.defineProperties(textarea, { clientHeight: { value: 72 }, scrollHeight: { value: 500 } });
		textarea.scrollTop = 100;
		f.panel.append(textarea);
		const e = wheel(textarea, 80);
		routeDockWheel(e, f.root, f.transcript);
		assert.equal(e.defaultPrevented, false);
		textarea.scrollTop = 0;
		const edge = wheel(textarea, -80);
		routeDockWheel(edge, f.root, f.transcript);
		assert.equal(edge.defaultPrevented, true);
		assert.equal(f.transcript.scrollTop, 1000);
	});
	it("contains wheel input over non-scrollable panel controls too", () => {
		const f = fixture();
		const e = wheel(f.panel, -200);
		routeDockWheel(e, f.root, f.transcript);
		assert.equal(e.defaultPrevented, true);
		assert.equal(f.transcript.scrollTop, 1000);
	});
	it("allows the whole-frame fallback to scroll without chaining into history", () => {
		const f = fixture();
		f.root.setAttribute("data-dock-surface", "");
		f.root.style.overflowY = "auto";
		Object.defineProperties(f.root, { clientHeight: { value: 120 }, scrollHeight: { value: 400 } });
		f.root.scrollTop = 50;
		const native = wheel(f.root, 50);
		routeDockWheel(native, f.root, f.transcript);
		assert.equal(native.defaultPrevented, false);
		f.root.scrollTop = 0;
		const edge = wheel(f.root, -100);
		routeDockWheel(edge, f.root, f.transcript);
		assert.equal(edge.defaultPrevented, true);
		assert.equal(f.transcript.scrollTop, 1000);
	});
	it("does not mistake hidden/visible overflow for a native scroll container", () => {
		const f = fixture();
		for (const overflow of ["hidden", "visible"]) {
			f.area.style.overflowY = overflow;
			const e = wheel(f.child, 100);
			routeDockWheel(e, f.root, f.transcript);
			assert.equal(e.defaultPrevented, true);
		}
	});
	it("retains composer/collapsed-bar forwarding with pixel/line/page units", () => {
		for (const [mode, amount] of [[0, 2], [1, 32], [2, 1200]]) {
			const f = fixture(false);
			const e = wheel(f.panel, -2, mode);
			routeDockWheel(e, f.root, f.transcript);
			assert.equal(f.transcript.scrollTop, 1000 - amount!);
			assert.equal(e.defaultPrevented, true);
		}
	});
	it("leaves horizontal scrolling, zoom, and previously consumed events alone", () => {
		const f = fixture(false);
		const consumed = wheel(f.panel, -100);
		consumed.preventDefault();
		for (const e of [wheel(f.panel, 0), wheel(f.panel, -100, 0, true), consumed]) {
			routeDockWheel(e, f.root, f.transcript);
			assert.equal(f.transcript.scrollTop, 1000);
		}
	});
});

describe("whole-form viewport budget", () => {
	it("subtracts outside chrome as well as the session breathing gap", () => {
		assert.equal(dockFormHeight(700, 600, 480), 548);
		assert.equal(dockFormHeight(500, 600, 480), 348);
		// More reading-note / stats wrapping consumes form space.
		assert.equal(dockFormHeight(500, 700, 480), 248);
	});
	it("never invents space outside a short viewport", () => {
		assert.equal(dockFormHeight(100, 500, 200), 0);
		assert.equal(dockFormHeight(0, 0, 0), 0);
	});
	it("does not grow the budget with a larger form", () => {
		assert.equal(dockFormHeight(700, 600, 480), dockFormHeight(700, 400, 280));
	});
});
