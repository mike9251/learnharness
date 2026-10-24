import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NextRequest } from "next/server.js";
import type { AuthInteraction } from "@earendil-works/pi-ai";
import { CopilotAuthError, copilotAuthResponse, createCopilotLoginManager } from "../src/server/copilot-login.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function harness() {
	let interaction!: AuthInteraction;
	let complete!: () => void;
	let fail!: (error: Error) => void;
	let connected = false;
	const manager = createCopilotLoginManager({
		connected: () => connected,
		logout: async () => { connected = false; },
		login: async (i) => {
			interaction = i;
			await new Promise<void>((resolve, reject) => {
				complete = resolve;
				fail = reject;
				i.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
			});
			i.signal!.throwIfAborted();
			connected = true;
		},
	});
	return { manager, interaction: () => interaction, complete: () => complete(), fail: () => fail(new Error("secret-token-from-provider")), connected: () => connected };
}

describe("Copilot login lifecycle", () => {
	it("projects only device information, fixes github.com, and completes without exposing credentials", async () => {
		const h = harness();
		const start = h.manager.start();
		assert.equal(start.state, "starting");
		await tick();
		assert.equal(await h.interaction().prompt({ type: "text", message: "GitHub Enterprise URL/domain (blank for github.com)" }), "");
		await assert.rejects(h.interaction().prompt({ type: "secret", message: "new unexpected prompt" }));
		h.interaction().notify({ type: "device_code", userCode: "ABCD-EFGH", verificationUri: "https://github.com/login/device", expiresInSeconds: 900 });
		assert.equal(h.manager.status(start.id).state, "waiting");
		assert.equal(h.manager.status(start.id).userCode, "ABCD-EFGH");
		h.complete();
		await tick();
		assert.deepEqual(h.manager.status(start.id), { id: start.id, state: "connected" });
		assert.equal(h.connected(), true);
		await h.manager.disconnect();
		assert.equal(h.connected(), false);
		assert.equal(h.manager.status(start.id).state, "cancelled");
	});

	it("cancels without a late completion saving a connection, then permits retry", async () => {
		const h = harness();
		const first = h.manager.start();
		await tick();
		assert.throws(() => h.manager.start(), (error) => error instanceof CopilotAuthError && error.status === 409);
		assert.equal((await h.manager.cancel(first.id)).state, "cancelled");
		h.complete();
		await tick();
		assert.equal(h.connected(), false);
		const second = h.manager.start();
		await tick();
		h.complete();
		await tick();
		assert.equal(h.manager.status(second.id).state, "connected");
	});

	it("sanitizes provider errors and rejects unknown session IDs", async () => {
		const h = harness();
		const start = h.manager.start();
		await tick();
		h.fail();
		await tick();
		const status = h.manager.status(start.id);
		assert.equal(status.state, "error");
		assert.doesNotMatch(JSON.stringify(status), /secret-token/);
		assert.throws(() => h.manager.status("not-a-session"), (error) => error instanceof CopilotAuthError && error.status === 404);
	});

	it("expires and aborts abandoned attempts", async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
		let signal!: AbortSignal;
		const manager = createCopilotLoginManager({
			timeoutMs: 100,
			connected: () => false,
			logout: async () => {},
			login: async (i) => {
				signal = i.signal!;
				await new Promise<void>((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
			},
		});
		const start = manager.start();
		await tick();
		t.mock.timers.tick(101);
		await tick();
		assert.equal(manager.status(start.id).state, "expired");
		assert.equal(signal.aborted, true);
	});

	it("does not offer a non-GitHub verification URL", async () => {
		const h = harness();
		const start = h.manager.start();
		await tick();
		assert.throws(() => h.interaction().notify({ type: "device_code", userCode: "CODE", verificationUri: "https://evil.example/login" }));
		assert.equal(h.manager.status(start.id).verificationUri, undefined);
		await h.manager.cancel(start.id);
	});

	it("disconnect cancels pending login before deleting credentials", async () => {
		const h = harness();
		const start = h.manager.start();
		await tick();
		await h.manager.disconnect();
		assert.equal(h.interaction().signal!.aborted, true);
		assert.equal(h.manager.status(start.id).state, "cancelled");
		assert.equal(h.connected(), false);
	});
});

describe("Copilot HTTP boundary", () => {
	it("requires same-origin mutations, blocks cross-site reads, and never caches responses", async () => {
		for (const method of ["POST", "DELETE"]) {
			for (const origin of [undefined, "null", "https://evil.example"]) {
				const res = await copilotAuthResponse(new Request("http://localhost:3000/api/auth/github-copilot", {
					method, headers: origin ? { origin } : {},
				}), () => { throw new Error("must not execute"); });
				assert.equal(res.status, 403);
			}
			const allowed = await copilotAuthResponse(new Request("http://localhost:3000/api/auth/github-copilot", {
				method, headers: { origin: "http://localhost:3000" },
			}), () => ({ connected: false }));
			assert.equal(allowed.status, 200);
			assert.equal(allowed.headers.get("cache-control"), "no-store");
		}
		const rejected = await copilotAuthResponse(new Request("http://localhost:3000/api/auth/github-copilot", {
			headers: { "sec-fetch-site": "cross-site" },
		}), () => ({}));
		assert.equal(rejected.status, 403);
	});
	it("uses the real NextRequest Host without equating loopback hosts or ports", async () => {
		for (const host of ["127.0.0.1:43210", "localhost:43210", "[::1]:43210"]) {
			for (const method of ["POST", "DELETE"]) {
				const request = new NextRequest(`http://${host}/api/auth/github-copilot/login`, {
					method, headers: { host, origin: `http://${host}`, "sec-fetch-site": "same-origin" },
				});
				assert.equal(new URL(request.url).hostname, "localhost", "Next normalizes loopback URL hosts");
				assert.equal((await copilotAuthResponse(request, () => ({ ok: true }))).status, 200);
				for (const origin of ["http://127.0.0.1:43210", "http://localhost:43210", "http://[::1]:43210",
					`http://${host.replace("43210", "43211")}`, `https://${host}`]) {
					if (origin === `http://${host}`) continue;
					const mismatched = new NextRequest(request.url, {
						method, headers: { host, origin, "sec-fetch-site": "same-origin" },
					});
					const rejected = await copilotAuthResponse(mismatched, () => { assert.fail("must not execute"); });
					assert.equal(rejected.status, 403, `${host} must reject ${origin}`);
				}
			}
		}
	});

	it("falls back to the exact plain Request URL only when Host is absent", async () => {
		for (const origin of ["http://127.0.0.1:3000", "http://localhost:3000", "http://127.0.0.1:3001"]) {
			const request = new Request("http://127.0.0.1:3000/api/auth/github-copilot", {
				method: "POST", headers: { origin },
			});
			const response = await copilotAuthResponse(request, () => ({ ok: true }));
			assert.equal(response.status, origin === "http://127.0.0.1:3000" ? 200 : 403);
		}
	});

	it("ignores forwarded-host spoofing and still rejects cross-site/same-site requests", async () => {
		for (const origin of ["http://127.0.0.1:3000", "https://evil.example"]) {
			const request = new NextRequest("http://127.0.0.1:3000/api/auth/github-copilot", {
				method: "POST", headers: {
					host: "127.0.0.1:3000", origin, "x-forwarded-host": "evil.example",
					"x-forwarded-proto": "https", forwarded: "host=evil.example;proto=https",
				},
			});
			assert.equal((await copilotAuthResponse(request, () => ({}))).status,
				origin === "http://127.0.0.1:3000" ? 200 : 403);
		}
		for (const site of ["cross-site", "same-site"]) {
			for (const method of ["GET", "POST", "DELETE"]) {
				const request = new NextRequest("http://127.0.0.1:3000/api/auth/github-copilot", {
					method, headers: { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000", "sec-fetch-site": site },
				});
				assert.equal((await copilotAuthResponse(request, () => { assert.fail("must not execute"); })).status, 403);
			}
		}
	});

	it("rejects malformed Host authorities rather than normalizing them into an allowed origin", async () => {
		for (const host of ["", "localhost:3000/", "localhost:3000?x", "localhost:3000#x",
			"user@localhost:3000", "localhost:3000\\evil", "localhost:3000,evil.example",
			"local host:3000", "local%68ost:3000", "localhost:", "localhost:65536", "http://localhost:3000"]) {
			const request = new Request("http://localhost:3000/api/auth/github-copilot", {
				method: "POST", headers: { host, origin: "http://localhost:3000" },
			});
			assert.equal((await copilotAuthResponse(request, () => { assert.fail("must not execute"); })).status, 403, host);
		}
	});

	it("preserves intentional HTTP errors from a retained manager across module reloads", async () => {
		const original = await import(new URL("../src/server/copilot-login.ts?hmr=original", import.meta.url).href) as typeof import("../src/server/copilot-login.ts");
		const reloaded = await import(new URL("../src/server/copilot-login.ts?hmr=reloaded", import.meta.url).href) as typeof import("../src/server/copilot-login.ts");
		assert.notEqual(original.CopilotAuthError, reloaded.CopilotAuthError, "must exercise two module instances");
		const manager = original.createCopilotLoginManager({
			connected: () => true, login: async () => {}, logout: async () => {},
		});
		const request = new Request("http://localhost:3000/api/auth/github-copilot");
		const conflict = await reloaded.copilotAuthResponse(request, () => manager.start());
		assert.equal(conflict.status, 409);
		assert.deepEqual(await conflict.json(), { error: "GitHub Copilot is already connected." });
		const missing = await reloaded.copilotAuthResponse(request, () => manager.status("missing"));
		assert.equal(missing.status, 404);
		assert.deepEqual(await missing.json(), { error: "Login attempt not found. Try connecting again." });
	});

	it("requires a branded Error with a string message and valid integer HTTP error status", async () => {
		const brand = Symbol.for("lh.copilotAuthError");
		const malformedMessage = new CopilotAuthError("private", 403);
		Object.defineProperty(malformedMessage, "message", { value: 42 });
		const errors: unknown[] = [
			{ [brand]: true, message: "private", status: 403 },
			Object.assign(new Error("private"), { status: 403 }),
			Object.assign(new Error("private"), { [brand]: "true", status: 403 }),
			malformedMessage,
			...[0, 200, 399, 600, NaN, 403.5].map((status) => new CopilotAuthError("private", status)),
		];
		for (const error of errors) {
			const response = await copilotAuthResponse(new Request("http://localhost:3000/api/auth/github-copilot"), () => { throw error; });
			assert.equal(response.status, 500);
			assert.doesNotMatch(await response.text(), /private/);
		}
	});

	it("does not return storage or provider error text", async () => {
		const res = await copilotAuthResponse(new Request("http://localhost:3000/api/auth/github-copilot"), () => { throw new Error("token=private"); });
		assert.equal(res.status, 500);
		assert.doesNotMatch(await res.text(), /private/);
	});
});
