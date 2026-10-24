import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { DictationBar, type Dictation, type DictationPhase } from "../components/dictation.tsx";

// Only the view is mounted: no useDictation, microphone, or network session.
const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	CustomEvent: dom.window.CustomEvent,
	IS_REACT_ACT_ENVIRONMENT: true,
	ResizeObserver: class {
		observe() {}
		disconnect() {}
	},
});

function dictationAt(phase: DictationPhase, overrides: Partial<Dictation> = {}): Dictation {
	return {
		phase,
		active: phase !== "idle",
		error: null,
		levelRef: { current: 0 },
		toggle: () => {},
		stop: () => {},
		finish: async () => {},
		cancel: () => {},
		clearError: () => {},
		...overrides,
	};
}

function documentFor(dictation: Dictation) {
	return parseHTML(`<html><body>${renderToStaticMarkup(<DictationBar dictation={dictation} />)}</body></html>`).document;
}

const stages = [
	["microphone", "Starting microphone…"],
	["connecting", "Connecting…"],
	["recording", "Listening…"],
	["stopping", "Finishing…"],
] as const;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function mount(dictation: Dictation) {
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => { root!.render(<DictationBar dictation={dictation} />); });
}

async function clickToggle() {
	const button = host!.querySelector('[data-testid="dictation-toggle"]');
	assert.ok(button);
	await act(async () => {
		button.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
	});
}

afterEach(async () => {
	await act(async () => { root?.unmount(); });
	root = null;
	host?.remove();
	host = null;
});

describe("DictationBar stage rendering", () => {
	it("idle retains the wide start affordance without an active status or meter", () => {
		const document = documentFor(dictationAt("idle"));
		const button = document.querySelector("button")!;
		assert.equal(button.getAttribute("aria-label"), "Start dictation");
		assert.equal(button.textContent, "Dictate");
		assert.ok(button.classList.contains("w-full"));
		assert.equal(document.querySelector('[role="status"]'), null);
		assert.equal(document.querySelector('[data-testid="dictation-meter"]'), null);
	});

	for (const [phase, label] of stages) {
		it(`${phase} has its own polite visible status beside the compact meter`, () => {
			const document = documentFor(dictationAt(phase));
			const status = document.querySelector('[role="status"]')!;
			assert.ok(status);
			assert.equal(status.getAttribute("aria-live"), "polite");
			assert.equal(status.textContent, label);
			assert.ok(!status.classList.contains("sr-only"));
			const meter = document.querySelector('[data-testid="dictation-meter"]')!;
			assert.equal(status.nextElementSibling, meter);
			assert.ok(meter.classList.contains("min-w-0"));
			assert.ok(meter.classList.contains("flex-1"));
			assert.equal(meter.children.length, 48);
			const button = document.querySelector("button")!;
			assert.equal(button.getAttribute("aria-label"), "Stop dictation");
			assert.equal(button.textContent?.trim(), "Stop");
			assert.equal(button.hasAttribute("disabled"), phase === "stopping");
			assert.equal(document.querySelector("audio"), null);
		});
	}

	it("idle failure retains the full error in its accessible label and truncated text", () => {
		const error = "Could not connect to dictation. Check the connection and try again.";
		const document = documentFor(dictationAt("idle", { error }));
		const button = document.querySelector("button")!;
		assert.equal(button.getAttribute("aria-label"), `Dictation failed: ${error}`);
		assert.equal(button.querySelector("span.truncate")!.textContent, error);
		assert.equal(document.querySelector('[data-testid="dictation-bar"]'), null);
	});

	it("the Hint callsite distinguishes keep from Escape discard and retains the error reveal", () => {
		// Radix keeps tooltip content out of SSR; pin the actual bar's Hint
		// props rather than a separate copy of the tooltip composition helper.
		const bar = readFileSync(new URL("../components/dictation.tsx", import.meta.url), "utf8")
			.split("export function DictationBar")[1]!;
		assert.match(bar, /label="Stop and keep transcription\. Escape cancels and discards\."/);
		assert.doesNotMatch(bar, /Stop dictation \(Esc\)/);
		assert.match(bar, /label=\{error \?\? "Dictate"\}/);
	});
});

describe("DictationBar interactions", () => {
	for (const phase of ["idle", "microphone", "connecting", "recording"] as const) {
		it(`${phase}: the button delegates to toggle, never discard`, async () => {
			let toggles = 0;
			let cancels = 0;
			await mount(dictationAt(phase, { toggle: () => { toggles++; }, cancel: () => { cancels++; } }));
			await clickToggle();
			assert.equal(toggles, 1);
			assert.equal(cancels, 0);
		});
	}

	it("stopping blocks duplicate Stop clicks while finishing remains visible", async () => {
		let toggles = 0;
		await mount(dictationAt("stopping", { toggle: () => { toggles++; } }));
		await clickToggle();
		assert.equal(toggles, 0);
		assert.equal(host!.querySelector('[role="status"]')!.textContent, "Finishing…");
	});

	it("an ordinary error retries through the existing toggle path", async () => {
		let toggles = 0;
		await mount(dictationAt("idle", { error: "Connection failed", toggle: () => { toggles++; } }));
		await clickToggle();
		assert.equal(toggles, 1);
	});

	it("the same mounted bar announces each readiness transition and clears when idle", async () => {
		await mount(dictationAt("microphone"));
		for (const [phase, label] of stages) {
			await act(async () => { root!.render(<DictationBar dictation={dictationAt(phase)} />); });
			assert.equal(host!.querySelector('[role="status"]')!.textContent, label);
		}
		await act(async () => { root!.render(<DictationBar dictation={dictationAt("idle")} />); });
		assert.equal(host!.querySelector('[role="status"]'), null);
		assert.equal(host!.querySelector('[data-testid="dictation-meter"]'), null);
	});
});
