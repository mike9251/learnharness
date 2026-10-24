import React, { act } from "react";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, describe, it } from "node:test";
import { runInNewContext } from "node:vm";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import ts from "typescript";
import type { Dictation } from "../components/dictation.tsx";
import type { DictationRunOptions } from "../components/dictation-run.ts";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	IS_REACT_ACT_ENVIRONMENT: true,
});

// Real React effects/ref lifetimes; only the engine and network boundary are
// mocked. Execute the shipped hook rather than duplicating its implementation.
const source = readFileSync(new URL("../components/dictation.tsx", import.meta.url), "utf8");
const javascript = ts.transpileModule(source, {
	compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
}).outputText;

type HookModule = {
	useDictation(options: { append(text: string): void }): Dictation;
	useDictationTarget(append: (text: string) => void, claimed: boolean): void;
	isDictationActive(): boolean;
	finishDictation(): Promise<void>;
};

function fixture() {
	const runs: FakeRun[] = [];
	let mints = 0;
	class FakeRun {
		stops = 0;
		cancels = 0;
		private done = false;
		private resolve!: () => void;
		finished = new Promise<void>((resolve) => { this.resolve = resolve; });
		constructor(readonly options: DictationRunOptions) { runs.push(this); }
		start() { this.options.onPhase("microphone"); }
		stop() { this.stops++; this.options.onPhase("stopping"); }
		cancel() { this.cancels++; this.complete(); }
		complete(text?: string, error: string | null = null) {
			if (this.done) return;
			this.done = true;
			if (text) this.options.onTranscript(text);
			this.options.onPhase("idle");
			this.options.onEnd(error);
			this.resolve();
		}
	}
	const sandbox = {
		exports: {} as HookModule,
		require: (name: string) => {
			if (name === "react") return React;
			if (name === "@/components/dictation-run") return { DictationRun: FakeRun };
			// The view and its dependencies are not rendered in these hook tests.
			return {};
		},
		window: dom.window,
		fetch: async () => {
			mints++;
			return { ok: true, json: async () => ({ token: "synthetic-test-token" }) };
		},
	};
	runInNewContext(javascript, sandbox);
	return { api: sandbox.exports, runs, mints: () => mints };
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let current: Dictation;

async function mount(f: ReturnType<typeof fixture>, append: (text: string) => void, claim?: (text: string) => void) {
	if (!host) {
		host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
	}
	await act(async () => { root!.render(<Probe api={f.api} append={append} claim={claim} />); });
}

function Probe({ api, append, claim }: { api: HookModule; append: (text: string) => void; claim?: (text: string) => void }) {
	current = api.useDictation({ append });
	api.useDictationTarget(claim ?? append, Boolean(claim));
	return null;
}

afterEach(async () => {
	await act(async () => { root?.unmount(); });
	root = null;
	host?.remove();
	host = null;
});

describe("useDictation engine binding", () => {
	it("same-tick controls use the run ref and finish resolves only after the append", async () => {
		const f = fixture();
		const appended: string[] = [];
		await mount(f, (text) => appended.push(text));
		const stale = current;
		let finished!: Promise<void>;
		await act(async () => {
			stale.toggle();
			assert.equal(f.api.isDictationActive(), true);
			stale.toggle();
			finished = stale.finish();
		});
		assert.equal(f.runs.length, 1);
		const run = f.runs[0]!;
		assert.equal(run.stops, 2);
		assert.equal(finished, run.finished);
		assert.equal(current.phase, "stopping");
		let resolved = false;
		void finished.then(() => { resolved = true; assert.deepEqual(appended, ["synthetic final"]); });
		await Promise.resolve();
		assert.equal(resolved, false);
		await act(async () => { run.complete("synthetic final"); await finished; });
		assert.equal(resolved, true);
		assert.equal(f.api.isDictationActive(), false);
		assert.equal(current.phase, "idle");
	});

	it("flush uses the latest composer append, while a mounted question claim takes priority", async () => {
		const f = fixture();
		const original: string[] = [];
		const latest: string[] = [];
		const question: string[] = [];
		await mount(f, (text) => original.push(text));
		await act(async () => { current.toggle(); });
		await mount(f, (text) => latest.push(text));
		await act(async () => { f.runs[0]!.complete("composer final"); });
		assert.deepEqual(original, []);
		assert.deepEqual(latest, ["composer final"]);
		await act(async () => { current.toggle(); });
		await mount(f, (text) => latest.push(text), (text) => question.push(text));
		await act(async () => { f.runs[1]!.complete("question final"); });
		assert.deepEqual(latest, ["composer final"]);
		assert.deepEqual(question, ["question final"]);
	});

	it("stale engine callbacks cannot mutate or end the replacement run", async () => {
		const f = fixture();
		const appended: string[] = [];
		await mount(f, (text) => appended.push(text));
		await act(async () => { current.toggle(); current.cancel(); current.toggle(); });
		assert.equal(f.runs.length, 2);
		const old = f.runs[0]!;
		await act(async () => {
			old.options.onLevel(0.8);
			old.options.onTranscript("stale synthetic final");
			old.options.onPhase("idle");
			old.options.onEnd("stale failure");
		});
		assert.equal(current.phase, "microphone");
		assert.equal(current.error, null);
		assert.equal(current.levelRef.current, 0);
		assert.equal(f.api.isDictationActive(), true);
		assert.deepEqual(appended, []);
		await act(async () => { f.runs[1]!.options.onLevel(0.2); });
		assert.equal(current.levelRef.current, 0.2);
	});

	it("keyboard seams delegate, and unmount discards, releases finish, and ignores late callbacks", async () => {
		const f = fixture();
		const appended: string[] = [];
		await mount(f, (text) => appended.push(text));
		await act(async () => { dom.window.dispatchEvent(new dom.window.Event("lh:kbd-toggle-dictation")); });
		await act(async () => { dom.window.dispatchEvent(new dom.window.Event("lh:kbd-cancel-dictation")); });
		assert.equal(f.runs[0]!.cancels, 1);
		await act(async () => { current.toggle(); });
		const run = f.runs[1]!;
		let finish!: Promise<void>;
		await act(async () => { finish = f.api.finishDictation(); });
		assert.equal(finish, run.finished);
		const mints = f.mints();
		await act(async () => { root!.unmount(); });
		root = null;
		await finish;
		assert.equal(run.cancels, 1);
		assert.equal(f.api.isDictationActive(), false);
		await f.api.finishDictation();
		run.options.onTranscript("late synthetic final");
		run.options.onLevel(0.9);
		run.options.onEnd("late failure");
		dom.window.dispatchEvent(new dom.window.Event("lh:kbd-toggle-dictation"));
		assert.equal(f.runs.length, 2);
		assert.equal(f.mints(), mints);
		assert.deepEqual(appended, []);
	});
});
