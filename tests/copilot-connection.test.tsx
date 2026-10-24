import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { CopilotConnection } from "../components/copilot-connection.tsx";
import { SetupDialog } from "../components/setup-dialog.tsx";
import { KeysSection } from "../components/settings/keys-section.tsx";
import { useZeroKeys } from "../components/setup-cta.tsx";
import { notifySettingsSaved, onSettingsSaved } from "../components/settings-signal.ts";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window, document: dom.document, Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement,
	HTMLTextAreaElement: dom.window.HTMLTextAreaElement, CustomEvent: dom.window.CustomEvent,
	IS_REACT_ACT_ENVIRONMENT: true,
});
const originalFetch = globalThis.fetch;
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
const AUTH = "/api/auth/github-copilot";
let root: Root | null = null;
let host: HTMLDivElement;
let requests: { path: string; method: string; init?: RequestInit }[];
let handler: (path: string, method: string) => Response | Promise<Response>;
let signals: string[];
let unsubscribe: () => void;
let copied: string[];

beforeEach(() => {
	requests = []; signals = []; copied = [];
	mock.timers.enable({ apis: ["setTimeout"] });
	handler = () => Response.json({ connected: false });
	globalThis.fetch = async (input, init) => {
		const path = String(input);
		const method = init?.method ?? "GET";
		requests.push({ path, method, init });
		return handler(path, method);
	};
	Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: { writeText: async (text: string) => { copied.push(text); } } } });
	unsubscribe = onSettingsSaved((section) => signals.push(section));
});

afterEach(async () => {
	await unmount();
	unsubscribe();
	mock.timers.reset();
	globalThis.fetch = originalFetch;
	if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
	else Reflect.deleteProperty(globalThis, "navigator");
});

async function mount(ui = <CopilotConnection />) {
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => { root!.render(ui); });
}
async function unmount() {
	await act(async () => { root?.unmount(); });
	root = null;
	host?.remove();
}
function button(text: string): HTMLButtonElement {
	const node = [...document.querySelectorAll("button")].find((b) => b.textContent === text);
	assert.ok(node, `expected button ${text}; got ${document.body.textContent}`);
	return node as HTMLButtonElement;
}
async function click(text: string) {
	await act(async () => { button(text).dispatchEvent(new dom.window.Event("click", { bubbles: true })); });
}
async function tick(ms = 2000) { await act(async () => { mock.timers.tick(ms); }); }
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => { resolve = r; });
	return { promise, resolve };
}
const waiting = { id: "capability", state: "waiting", userCode: "ABCD-1234", verificationUri: "https://github.com/login/device" };
function loginHandler(poll: () => Response | Promise<Response> = () => Response.json(waiting)) {
	handler = (path, method) => {
		if (path === AUTH) return Response.json({ connected: false });
		if (method === "POST") return Response.json({ id: waiting.id, state: "starting" });
		if (method === "DELETE") return Response.json({ id: waiting.id, state: "cancelled" });
		return poll();
	};
}
const loginDeletes = () => requests.filter((r) => r.path.startsWith(`${AUTH}/login/`) && r.method === "DELETE");

describe("Copilot device connection", () => {
	it("shows account notice, polls at 2s, copies the code, and uses a normal github.com external link", async () => {
		loginHandler();
		await mount();
		assert.match(document.body.textContent!, /Connecting may enable eligible models on your GitHub account\./);
		await click("Connect");
		const post = requests.find((r) => r.method === "POST")!;
		assert.equal(post.path, `${AUTH}/login`);
		assert.equal(new Headers(post.init?.headers).get("content-type"), "application/json");
		assert.deepEqual(JSON.parse(String(post.init?.body)), {});
		assert.match(document.body.textContent!, /Starting GitHub login/);
		await tick(1999);
		assert.equal(requests.filter((r) => r.path === `${AUTH}/login/capability`).length, 0);
		await tick(1);
		assert.match(document.body.textContent!, /Waiting for GitHub authorization/);
		assert.equal(document.querySelector('[data-testid="copilot-code"]')?.textContent, "ABCD-1234");
		await click("Copy");
		assert.deepEqual(copied, ["ABCD-1234"]);
		const link = document.querySelector("a")!;
		assert.equal(link.getAttribute("href"), "https://github.com/login/device");
		assert.equal(link.getAttribute("target"), "_blank");
		assert.match(link.getAttribute("rel")!, /noopener/);
		await click("Cancel");
		assert.equal(loginDeletes().length, 1);
		button("Retry");
		const count = requests.length;
		await tick(10000);
		assert.equal(requests.length, count);
		await unmount();
		assert.equal(loginDeletes().length, 1);
		assert.deepEqual(signals, []);
	});

	it("success stops polling and unmount never cancels it; disconnect only deletes local auth", async () => {
		loginHandler(() => Response.json({ id: waiting.id, state: "connected" }));
		await mount();
		await click("Connect");
		await tick();
		assert.match(document.body.textContent!, /Connected/);
		assert.match(document.body.textContent!, /GitHub tracks Copilot subscription usage; dollar costs are unavailable\./);
		assert.match(document.body.textContent!, /local credentials only/);
		assert.deepEqual(signals, ["keys"]);
		const count = requests.length;
		await tick(10000);
		assert.equal(requests.length, count);
		await click("Disconnect");
		button("Connect");
		assert.equal(requests.at(-1)?.path, AUTH);
		assert.equal(requests.at(-1)?.method, "DELETE");
		assert.deepEqual(signals, ["keys", "keys"]);
		await unmount();
		assert.equal(loginDeletes().length, 0);
	});

	for (const close of ["unmount", "Cancel"] as const) {
		it(`cancels exactly once after a pending POST resolves following ${close}`, async () => {
			const post = deferred<Response>();
			handler = (_path, method) => method === "POST" ? post.promise : Response.json({ connected: false });
			await mount();
			await click("Connect");
			if (close === "unmount") await unmount(); else await click("Cancel");
			assert.equal(loginDeletes().length, 0);
			await act(async () => { post.resolve(Response.json(waiting)); });
			assert.equal(loginDeletes().length, 1);
			await tick(10000);
			assert.equal(loginDeletes().length, 1);
			assert.deepEqual(signals, []);
		});
	}

	for (const close of ["Cancel", "unmount"] as const) {
		it(`reconciles a login completed before ${close} without logging it out`, async () => {
			const deletion = deferred<Response>();
			const poll = deferred<Response>();
			handler = (path, method) => {
				if (path === AUTH) return Response.json({ connected: false });
				if (method === "POST") return Response.json(waiting);
				if (method === "DELETE") return deletion.promise;
				return poll.promise;
			};
			await mount(); await click("Connect"); await tick();
			if (close === "Cancel") {
				await click("Cancel");
				assert.match(document.body.textContent!, /Cancelling GitHub login/);
				assert.equal([...document.querySelectorAll("button")].some((b) => b.textContent === "Retry"), false);
			} else await unmount();
			await act(async () => { deletion.resolve(Response.json({ id: waiting.id, state: "connected" })); });
			if (close === "Cancel") button("Disconnect");
			assert.deepEqual(signals, ["keys"]);
			await act(async () => { poll.resolve(Response.json({ id: waiting.id, state: "connected" })); });
			assert.deepEqual(signals, ["keys"], "late poll must not announce success twice");
			assert.equal(requests.some((r) => r.path === AUTH && r.method === "DELETE"), false);
			assert.equal(loginDeletes().length, 1);
		});
	}

	it("a failed cancellation reconciles the same attempt before allowing a fresh login", async () => {
		let failDelete = true;
		handler = (path, method) => {
			if (path === AUTH) return Response.json({ connected: false });
			if (method === "POST") return Response.json(waiting);
			if (method === "DELETE") return failDelete
				? Response.json({ error: "Cancel failed" }, { status: 503 })
				: Response.json({ id: waiting.id, state: "cancelled" });
			return Response.json(waiting);
		};
		await mount(); await click("Connect"); await click("Cancel");
		assert.match(document.body.textContent!, /Cancel failed/);
		failDelete = false;
		await click("Retry");
		assert.equal(requests.filter((r) => r.method === "POST").length, 1);
		assert.equal(loginDeletes().length, 2);
		await click("Retry");
		assert.equal(requests.filter((r) => r.method === "POST").length, 2);
	});

	it("does not cancel a POST that reports success after close", async () => {
		const post = deferred<Response>();
		handler = (_path, method) => method === "POST" ? post.promise : Response.json({ connected: false });
		await mount(); await click("Connect"); await unmount();
		await act(async () => { post.resolve(Response.json({ id: waiting.id, state: "connected" })); });
		assert.equal(loginDeletes().length, 0);
		assert.deepEqual(signals, ["keys"]);
	});

	it("unmount cancels a known waiting login and ignores an in-flight poll", async () => {
		const response = deferred<Response>();
		loginHandler(() => response.promise);
		await mount(); await click("Connect"); await tick(); await unmount();
		assert.equal(loginDeletes().length, 1);
		await act(async () => { response.resolve(Response.json(waiting)); });
		const count = requests.length;
		await tick(10000);
		assert.equal(requests.length, count);
	});

	for (const state of ["error", "expired", "cancelled"]) {
		it(`${state} is terminal and Retry starts a fresh login`, async () => {
			loginHandler(() => Response.json({ id: waiting.id, state, ...(state === "error" ? { error: "Access denied" } : {}) }));
			await mount(); await click("Connect"); await tick();
			button("Retry");
			if (state === "error") assert.match(document.querySelector('[role="alert"]')!.textContent!, /Access denied/);
			const count = requests.length;
			await tick(10000); assert.equal(requests.length, count);
			await click("Retry");
			assert.equal(requests.filter((r) => r.method === "POST").length, 2);
			assert.equal(loginDeletes().length, 0, "terminal attempts are never cancelled");
		});
	}

	it("HTTP errors remain inline, stop polling, and notify nothing", async () => {
		loginHandler(() => Response.json({ error: "Login lookup unavailable" }, { status: 503 }));
		await mount(); await click("Connect"); await tick();
		assert.equal(document.querySelector('[role="alert"]')?.textContent, "Login lookup unavailable");
		button("Retry");
		assert.equal(loginDeletes().length, 1, "release the pending login after a poll error");
		const count = requests.length;
		await tick(10000); assert.equal(requests.length, count);
		assert.deepEqual(signals, []);
	});

	it("failed status and disconnect requests can be retried without starting a login", async () => {
		handler = () => Response.json({ error: "Status unavailable" }, { status: 503 });
		await mount(); button("Retry");
		handler = () => Response.json({ connected: true });
		await click("Retry"); button("Disconnect");
		handler = () => Response.json({ error: "Disconnect unavailable" }, { status: 503 });
		await click("Disconnect"); button("Retry");
		assert.deepEqual(signals, []);
		handler = () => Response.json({ connected: false });
		await click("Retry"); button("Connect");
		assert.deepEqual(signals, ["keys"]);
		assert.equal(requests.filter((r) => r.method === "POST").length, 0);
	});

	it("never links to an enterprise or untrusted verification host", async () => {
		loginHandler(() => Response.json({ ...waiting, verificationUri: "https://github.example.com/login/device" }));
		await mount(); await click("Connect"); await tick();
		assert.equal(document.querySelector("a"), null);
		button("Copy"); button("Cancel");
	});
});

describe("Copilot setup and settings integration", () => {
	it("Keys settings has a separate connection row, not an API-key dropdown entry", async () => {
		handler = (path) => path === "/api/keys" ? Response.json({ keys: [], providers: [] }) : Response.json({ connected: false });
		await mount(<KeysSection />);
		assert.ok(document.querySelector('[data-testid="group-provider-keys"] [data-testid="copilot-connection"]'));
		button("Connect"); button("+ Add provider key");
		assert.equal(document.querySelector('[data-testid="key-github-copilot-editor"]'), null);
	});

	it("first-time connection advances to empty model pickers without saving or sending", async () => {
		let connected = false;
		handler = (path, method) => {
			if (path === "/api/keys") return Response.json({ keys: [], providers: [], copilot: { connected } });
			if (path === "/api/models") return Response.json({ models: [], providers: connected ? [{ id: "github-copilot", keyPresent: true }] : [], slots: { strong: null, cheap: null, vision: null } });
			if (path === AUTH) return Response.json({ connected });
			if (method === "POST") return Response.json({ id: waiting.id, state: "starting" });
			assert.equal(method, "GET", "success must not cancel login or save models");
			connected = true;
			return Response.json({ id: waiting.id, state: "connected" });
		};
		await mount(<SetupDialog open onClose={() => {}} onDone={() => assert.fail("must not select models or send")} />);
		assert.ok(document.querySelector('[data-testid="setup-key-provider"]'));
		await click("Connect GitHub Copilot"); await tick();
		assert.ok(document.querySelector('[data-testid="setup-stage-pickers"]'));
		assert.equal(document.querySelector('[data-testid="copilot-connection"]'), null, "stage advance unmounts the successful connection UI");
		const afterSuccess = requests.length;
		await tick(10000);
		assert.equal(requests.length, afterSuccess, "success teardown neither cancels nor polls again");
		for (const slot of ["strong", "cheap", "vision"]) {
			assert.ok(document.querySelector(`[data-testid="setup-needed-${slot}"]`));
			assert.match(document.querySelector(`[data-testid="setup-trigger-${slot}"]`)!.textContent!, /Pick a model/);
		}
		assert.deepEqual(signals, ["keys"]);
		assert.equal(requests.filter((r) => r.method !== "GET").length, 1);
		assert.equal(loginDeletes().length, 0);
	});

	it("closing setup with open=false cancels even while its login POST is in flight", async () => {
		const post = deferred<Response>();
		handler = (path, method) => {
			if (path === "/api/keys") return Response.json({ keys: [], providers: [] });
			if (path === "/api/models") return Response.json({ models: [], providers: [] });
			return method === "POST" ? post.promise : Response.json({ connected: false });
		};
		function Harness() {
			const [open, setOpen] = React.useState(true);
			return <SetupDialog open={open} onClose={() => setOpen(false)} onDone={() => assert.fail("must not save")} />;
		}
		await mount(<Harness />); await click("Connect GitHub Copilot");
		await act(async () => { document.querySelector('[data-testid="setup-close"]')!.dispatchEvent(new dom.window.Event("click", { bubbles: true })); });
		await act(async () => { post.resolve(Response.json(waiting)); });
		assert.equal(loginDeletes().length, 1);
	});

	it("useZeroKeys follows Copilot-only connection and disconnection signals", async () => {
		let connected = true;
		handler = () => Response.json({ keys: [], providers: [], copilot: { connected } });
		function Probe() { return <span data-testid="zero">{String(useZeroKeys())}</span>; }
		await mount(<Probe />);
		assert.equal(document.querySelector('[data-testid="zero"]')?.textContent, "false");
		connected = false;
		await act(async () => { notifySettingsSaved("keys"); });
		assert.equal(document.querySelector('[data-testid="zero"]')?.textContent, "true");
		connected = true;
		await act(async () => { notifySettingsSaved("keys"); });
		assert.equal(document.querySelector('[data-testid="zero"]')?.textContent, "false");
	});
});
