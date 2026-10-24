import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { after, test } from "node:test";
import type { Credential, OAuthCredential } from "@earendil-works/pi-ai";

// No real credentials: even the singleton is redirected before its import.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-oauth-store-"));
process.env.LH_AUTH_FILE = path.join(root, "auth.json");
const { createOAuthStore } = await import("../src/store/oauth.ts");
after(() => fs.rmSync(root, { recursive: true, force: true }));
const provider = "github-copilot";
const token = (access = "test-access"): OAuthCredential => ({
	type: "oauth", access, refresh: "test-refresh", expires: 123,
	availableModelIds: ["test-model"], enterpriseUrl: "https://example.invalid",
	futureMetadata: { nested: [1, true, null] },
});
function setup() {
	const dir = fs.mkdtempSync(path.join(root, "case-"));
	const file = path.join(dir, "oauth.json");
	return { dir, file, store: createOAuthStore(file) };
}
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}

test("missing, persistence, metadata-only listing, fresh/cloned reads and 0600 atomic replacement", async () => {
	const { dir, file, store } = setup();
	const auth = path.join(dir, "auth.json");
	fs.writeFileSync(auth, '{"EXISTING_KEY":"test-only"}');
	assert.equal(await store.read(provider), undefined);
	assert.equal(store.readCredential(provider), undefined);
	assert.deepEqual(await store.list(), []);
	await store.delete(provider);
	assert.equal(fs.existsSync(file), false);
	const result = await store.modify(provider, async () => token());
	assert.deepEqual(result, token());
	assert.equal(fs.statSync(file).mode & 0o777, 0o600);
	const fresh = createOAuthStore(file);
	assert.deepEqual(await fresh.read(provider), token());
	assert.deepEqual(await fresh.list(), [{ providerId: provider, type: "oauth" }]);
	const read = fresh.readCredential(provider)!;
	read.access = "mutated";
	(read.availableModelIds as string[]).push("not-persisted");
	assert.deepEqual(await store.read(provider), token());
	fs.writeFileSync(file, JSON.stringify({ [provider]: token("hand-edited") }));
	assert.equal(store.readCredential(provider)?.access, "hand-edited");
	fs.chmodSync(file, 0o644);
	await fresh.modify(provider, async () => token("replacement"));
	assert.equal(fs.statSync(file).mode & 0o777, 0o600);
	assert.deepEqual(fs.readdirSync(dir).sort(), ["auth.json", "oauth.json"]);
	assert.equal(fs.readFileSync(auth, "utf8"), '{"EXISTING_KEY":"test-only"}');
});

test("undefined callback return leaves credential unchanged, including callback mutations", async () => {
	const { file, store } = setup();
	assert.equal(await store.modify(provider, async () => undefined), undefined);
	assert.equal(fs.existsSync(file), false);
	await store.modify(provider, async () => token());
	const before = fs.readFileSync(file, "utf8");
	assert.deepEqual(await store.modify(provider, async (current) => {
		(current as OAuthCredential).access = "not-persisted";
		return undefined;
	}), token());
	assert.equal(fs.readFileSync(file, "utf8"), before);
	await assert.rejects(store.modify(provider, async () => { throw new Error("refresh failed"); }), /refresh failed/);
	assert.equal(fs.readFileSync(file, "utf8"), before);
	await store.modify(provider, async () => token("lock-released"));
});

test("refresh callbacks serialize across instances and see the rotated token", async () => {
	const { file, store } = setup();
	await store.modify(provider, async () => token("expired"));
	const entered = deferred();
	const release = deferred();
	let refreshes = 0;
	const refresh = async (current: Credential | undefined) => {
		if ((current as OAuthCredential).access !== "expired") return undefined;
		refreshes++;
		entered.resolve();
		await release.promise;
		return token("rotated");
	};
	const first = store.modify(provider, refresh);
	await entered.promise;
	const second = createOAuthStore(file).modify(provider, refresh);
	await delay(50);
	assert.equal(refreshes, 1);
	release.resolve();
	assert.deepEqual(await Promise.all([first, second]), [token("rotated"), token("rotated")]);
	assert.equal(refreshes, 1);
});

test("logout queued during refresh wins; login queued during refresh sees refreshed state", async () => {
	for (const operation of ["logout", "login"] as const) {
		const { file, store } = setup();
		await store.modify(provider, async () => token());
		const entered = deferred();
		const release = deferred();
		const refresh = store.modify(provider, async () => {
			entered.resolve();
			await release.promise;
			return token("refreshed");
		});
		await entered.promise;
		const other = createOAuthStore(file);
		const queued = operation === "logout" ? other.delete(provider) : other.modify(provider, async (current) => {
			assert.equal((current as OAuthCredential).access, "refreshed");
			return token("new-login");
		});
		release.resolve();
		await Promise.all([refresh, queued]);
		assert.deepEqual(await store.read(provider), operation === "logout" ? undefined : token("new-login"));
	}
});

test("pre-aborted operations never touch storage or run callbacks", async () => {
	const { dir, file, store } = setup();
	const controller = new AbortController();
	controller.abort();
	const options = { signal: controller.signal };
	await assert.rejects(store.read(provider, options), { name: "AbortError" });
	await assert.rejects(store.list(options), { name: "AbortError" });
	await assert.rejects(store.delete(provider, options), { name: "AbortError" });
	await assert.rejects(store.modify(provider, async () => { assert.fail("must not run"); }, options), { name: "AbortError" });
	assert.equal(fs.existsSync(file), false);
	assert.deepEqual(fs.readdirSync(dir), []);
});

test("abort during refresh prevents commit and releases lock", async () => {
	const { dir, file, store } = setup();
	await store.modify(provider, async () => token());
	const before = fs.readFileSync(file, "utf8");
	const controller = new AbortController();
	await assert.rejects(store.modify(provider, async () => {
		controller.abort();
		return token("must-not-write");
	}, { signal: controller.signal }), { name: "AbortError" });
	assert.equal(fs.readFileSync(file, "utf8"), before);
	assert.deepEqual(fs.readdirSync(dir), ["oauth.json"]);
	await store.delete(provider);
	assert.equal(await store.read(provider), undefined);
});

test("waiting writers/logout are cancellable and never steal even an old lock", async () => {
	const { file, store } = setup();
	await store.modify(provider, async () => token());
	const lock = `${file}.lock`;
	fs.mkdirSync(lock);
	fs.utimesSync(lock, new Date(0), new Date(0));
	for (const operation of ["modify", "delete"] as const) {
		const controller = new AbortController();
		const options = { signal: controller.signal };
		const pending = operation === "delete" ? store.delete(provider, options) : store.modify(provider, async () => {
			assert.fail("must not enter locked callback");
		}, options);
		const rejection = assert.rejects(pending, { name: "AbortError" });
		await delay(40);
		controller.abort();
		await rejection;
		assert.equal(fs.existsSync(lock), true);
		assert.deepEqual(await store.read(provider), token());
	}
	fs.rmdirSync(lock);
});

test("lock waits are bounded and timeout leaves an orphan lock/data untouched", async (t) => {
	const { file, store } = setup();
	await store.modify(provider, async () => token());
	const lock = `${file}.lock`;
	fs.mkdirSync(lock);
	t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
	const pending = store.modify(provider, async () => { assert.fail("lock must not be stolen"); });
	const rejection = assert.rejects(pending, /Timed out waiting for OAuth credential lock/);
	t.mock.timers.tick(30_001);
	await rejection;
	assert.equal(fs.existsSync(lock), true);
	assert.deepEqual(await store.read(provider), token());
});

test("edits/corruption during an awaited refresh are not overwritten", async () => {
	for (const replacement of ["{invalid-json", JSON.stringify({ [provider]: token("external-login") })]) {
		const { file, store } = setup();
		await store.modify(provider, async () => token());
		await assert.rejects(store.modify(provider, async () => {
			fs.writeFileSync(file, replacement);
			return token("stale-refresh");
		}), /Invalid OAuth|changed during modification/);
		assert.equal(fs.readFileSync(file, "utf8"), replacement);
	}
});

test("malformed files reject every access/mutation without overwriting or leaking token text", async () => {
	const invalid = [
		'{"access":"secret-test-marker",', "null", "[]", "42",
		JSON.stringify({ [provider]: { ...token(), access: 42 } }),
		JSON.stringify({ [provider]: { ...token(), refresh: null } }),
		JSON.stringify({ [provider]: { ...token(), expires: "tomorrow" } }),
		JSON.stringify({ [provider]: { type: "api_key", key: "test-key" } }),
	];
	for (const raw of invalid) {
		const { file, dir, store } = setup();
		fs.writeFileSync(file, raw);
		const safeError = (error: unknown) => {
			assert.ok(error instanceof Error);
			assert.equal(error.message.includes("secret-test-marker"), false);
			return true;
		};
		assert.throws(() => store.readCredential(provider), safeError);
		await assert.rejects(store.read(provider), safeError);
		await assert.rejects(store.list(), safeError);
		await assert.rejects(store.modify(provider, async () => { assert.fail("invalid store must not invoke callback"); }), safeError);
		await assert.rejects(store.delete(provider), safeError);
		assert.equal(fs.readFileSync(file, "utf8"), raw);
		assert.deepEqual(fs.readdirSync(dir), ["oauth.json"]);
	}
});

test("invalid returned tokens and storage path failures preserve existing data", async () => {
	const { dir, file, store } = setup();
	await store.modify(provider, async () => token());
	const before = fs.readFileSync(file, "utf8");
	for (const invalid of [{ type: "api_key", key: "test" }, { ...token(), access: false }, { ...token(), expires: NaN }]) {
		await assert.rejects(store.modify(provider, async () => invalid as Credential), /Invalid OAuth/);
		assert.equal(fs.readFileSync(file, "utf8"), before);
	}
	const badFile = path.join(dir, "directory.json");
	fs.mkdirSync(badFile);
	await assert.rejects(createOAuthStore(badFile).read(provider), /regular file/);
	await assert.rejects(createOAuthStore(badFile).modify(provider, async () => token()), /regular file/);
	const symlink = path.join(dir, "symlink.json");
	fs.symlinkSync(file, symlink);
	await assert.rejects(createOAuthStore(symlink).delete(provider), /regular file/);
	assert.equal(fs.readFileSync(file, "utf8"), before);
	const blocked = createOAuthStore(path.join(file, "child.json"));
	await assert.rejects(blocked.read(provider));
	await assert.rejects(blocked.modify(provider, async () => token()));
});

test("failed atomic replacement preserves the old file and cleans temporary files/lock", async (t) => {
	const { dir, file, store } = setup();
	await store.modify(provider, async () => token());
	const before = fs.readFileSync(file, "utf8");
	const mock = t.mock.method(fs, "renameSync", (source: fs.PathLike, destination: fs.PathLike) => {
		assert.equal(destination, file);
		assert.equal(fs.statSync(source).mode & 0o777, 0o600);
		assert.equal(fs.readFileSync(file, "utf8"), before);
		JSON.parse(fs.readFileSync(source, "utf8"));
		throw Object.assign(new Error("simulated storage failure"), { code: "EIO" });
	});
	await assert.rejects(store.modify(provider, async () => token("not-committed")), /simulated storage failure/);
	assert.equal(fs.readFileSync(file, "utf8"), before);
	assert.deepEqual(fs.readdirSync(dir), ["oauth.json"]);
	mock.mock.restore();
	await store.modify(provider, async () => token("retry-succeeded"));
});

test("all entries must be OAuth; valid provider metadata survives unrelated writes/deletes", async () => {
	const { store } = setup();
	await store.modify("other-oauth-provider", async () => token("other"));
	await store.modify(provider, async () => token());
	await store.delete(provider);
	assert.deepEqual(await store.read("other-oauth-provider"), token("other"));
	assert.deepEqual(await store.list(), [{ providerId: "other-oauth-provider", type: "oauth" }]);
	assert.equal(await store.read("toString"), undefined);
});

test("filesystem lock serializes refresh across independent Node processes", { timeout: 10_000 }, async (t) => {
	const { file, store } = setup();
	await store.modify(provider, async () => token("expired"));
	const moduleUrl = new URL("../src/store/oauth.ts", import.meta.url).href;
	function child(hold: boolean) {
		const code = `
			import { createOAuthStore } from ${JSON.stringify(moduleUrl)};
			process.send({ kind: 'started' });
			await createOAuthStore(${JSON.stringify(file)}).modify('github-copilot', async current => {
				process.send({ kind: 'entered', access: current.access });
				${hold ? "await new Promise(resolve => process.once('message', resolve));" : ""}
				return current.access === 'expired' ? { ...current, access: 'child-rotated' } : undefined;
			});
			process.disconnect();
		`;
		const proc = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
			stdio: ["ignore", "pipe", "pipe", "ipc"],
		});
		t.after(() => { if (proc.exitCode === null) proc.kill(); });
		return proc;
	}
	const first = child(true);
	const firstMessages: unknown[] = [];
	first.on("message", (message) => firstMessages.push(message));
	while (firstMessages.length < 2) await once(first, "message");
	assert.deepEqual(firstMessages[1], { kind: "entered", access: "expired" });
	const second = child(false);
	const secondMessages: unknown[] = [];
	second.on("message", (message) => secondMessages.push(message));
	await once(second, "message");
	await delay(50);
	assert.deepEqual(secondMessages, [{ kind: "started" }]);
	const exits = Promise.all([once(first, "exit"), once(second, "exit")]);
	first.send("release");
	assert.deepEqual(await exits, [[0, null], [0, null]]);
	assert.deepEqual(secondMessages[1], { kind: "entered", access: "child-rotated" });
	assert.equal(store.readCredential(provider)?.access, "child-rotated");
});
