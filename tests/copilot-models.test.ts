import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolate auth AND settings before any composition-root imports.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-copilot-models-"));
process.env.LH_AUTH_FILE = path.join(root, "auth.json");
process.env.LH_DATA_DIR = path.join(root, "data");
const { oauthStore } = await import("../src/store/oauth.ts");
const { copilotStatus, copilotModels, copilotLogin } = await import("../src/server/copilot.ts");
const { piModels, piEngineForSpec } = await import("../src/agent/models.ts");
const { modelCatalog, catalogContextLimits } = await import("../src/server/model-catalog.ts");
const { providerKeyPresent } = await import("../src/server/keys.ts");
const { providerKeyMissing, isProviderKeyRefusal } = await import("../src/core/settings.ts");
const ID = "github-copilot";
const first = piModels().getModels(ID)[0]!;
const second = piModels().getModels(ID)[1]!;
const initial = {
	type: "oauth" as const,
	access: "tid=fake;proxy-ep=proxy.individual.githubcopilot.com;",
	refresh: "fake-github-token",
	expires: Date.now() + 3600_000,
	availableModelIds: [first.id],
};
after(() => fs.rmSync(root, { recursive: true, force: true }));

describe("Copilot model composition", () => {
	it("federates only saved-account models, including context limits and send guards", async () => {
		await oauthStore.delete(ID);
		assert.equal(copilotStatus().connected, false);
		assert.equal(providerKeyPresent(ID), false);
		const refusal = providerKeyMissing(ID, ["strong"]);
		assert.match(refusal.error, /reconnect/);
		assert.equal(isProviderKeyRefusal(refusal.error), true);
		assert.deepEqual(copilotModels(), []);
		await oauthStore.modify(ID, async () => initial);
		assert.equal(providerKeyPresent(ID), true);
		const catalog = modelCatalog();
		assert.deepEqual(catalog.models.filter((m) => m.provider === ID).map((m) => m.id), [first.id]);
		assert.deepEqual(catalog.providers.find((p) => p.id === ID), { id: ID, keyPresent: true });
		assert.equal(catalogContextLimits().get(`${ID}:${first.id}`), first.contextWindow);
		assert.equal(catalogContextLimits().has(`${ID}:${second.id}`), false);
		assert.equal(piEngineForSpec({ provider: ID, id: first.id }).model.id, first.id);
	});

	it("uses persisted OAuth auth and account endpoint after rebuilding a store view", async () => {
		await oauthStore.modify(ID, async () => ({ ...initial, access: "tid=fake;proxy-ep=proxy.business.githubcopilot.com;" }));
		const auth = await piModels().getAuth(ID);
		assert.equal(auth?.auth.baseUrl, "https://api.business.githubcopilot.com");
		assert.equal(auth?.auth.apiKey, "tid=fake;proxy-ep=proxy.business.githubcopilot.com;");
		const { createOAuthStore } = await import("../src/store/oauth.ts");
		assert.equal(createOAuthStore(path.join(root, "oauth.json")).readCredential(ID)?.access, auth?.auth.apiKey);
	});

	it("automatically refreshes once under concurrent requests and persists availability", async () => {
		await oauthStore.modify(ID, async () => ({ ...initial, expires: 0 }));
		const originalFetch = globalThis.fetch;
		let tokenCalls = 0;
		let catalogCalls = 0;
		globalThis.fetch = async (input, init) => {
			const url = String(input);
			if (url === "https://api.github.com/copilot_internal/v2/token") {
				tokenCalls++;
				assert.equal(new Headers(init?.headers).get("authorization"), "Bearer fake-github-token");
				return Response.json({ token: "tid=renewed;proxy-ep=proxy.individual.githubcopilot.com;", expires_at: Math.floor(Date.now() / 1000) + 3600 });
			}
			if (url === "https://api.individual.githubcopilot.com/models") {
				catalogCalls++;
				return Response.json({ data: [{ id: second.id, model_picker_enabled: true, policy: { state: "enabled" }, capabilities: { supports: { tool_calls: true } } }] });
			}
			throw new Error(`Unexpected network request: ${url}`);
		};
		try {
			const auths = await Promise.all([piModels().getAuth(ID), piModels().getAuth(ID), piModels().getAuth(ID)]);
			assert.equal(tokenCalls, 1);
			assert.equal(catalogCalls, 1);
			for (const auth of auths) assert.match(auth!.auth.apiKey!, /renewed/);
			assert.deepEqual(oauthStore.readCredential(ID)?.availableModelIds, [second.id]);
			assert.deepEqual(copilotModels().map((m) => m.id), [second.id]);
		} finally { globalThis.fetch = originalFetch; }
	});

	it("preserves credentials on refresh failure without falling back to ambient tokens", async () => {
		await oauthStore.modify(ID, async () => ({ ...initial, expires: 0 }));
		const originalFetch = globalThis.fetch;
		const env = process.env.COPILOT_GITHUB_TOKEN;
		process.env.COPILOT_GITHUB_TOKEN = "must-not-be-used";
		globalThis.fetch = async () => new Response("fake-revoked-token", { status: 401 });
		try {
			await assert.rejects(piModels().getAuth(ID));
			assert.equal(oauthStore.readCredential(ID)?.refresh, initial.refresh);
			await copilotLogin.disconnect();
			assert.equal(await piModels().getAuth(ID), undefined);
			assert.equal(providerKeyPresent(ID), false);
			assert.deepEqual(copilotModels(), []);
			assert.equal(modelCatalog().models.some((m) => m.provider === ID), false);
		} finally {
			globalThis.fetch = originalFetch;
			if (env === undefined) delete process.env.COPILOT_GITHUB_TOKEN;
			else process.env.COPILOT_GITHUB_TOKEN = env;
		}
	});

	it("does not let other OAuth entries change existing API-key precedence", async () => {
		await oauthStore.modify("openai", async () => initial);
		const env = process.env.OPENAI_API_KEY;
		process.env.OPENAI_API_KEY = "existing-openai-api-key";
		try {
			assert.equal((await piModels().getAuth("openai"))?.auth.apiKey, "existing-openai-api-key");
		} finally {
			if (env === undefined) delete process.env.OPENAI_API_KEY;
			else process.env.OPENAI_API_KEY = env;
			await oauthStore.delete("openai");
		}
	});
});
