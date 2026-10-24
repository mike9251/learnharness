import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { AUTH_KEYS, AUTH_PROVIDER_ENV_VARS } from "../src/core/auth-keys.ts";

// Set isolation before importing the composition root: neither saved keys,
// OAuth credentials, nor settings may come from the developer's installation.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-merged-provider-catalog-"));
process.env.LH_AUTH_FILE = path.join(root, "auth.json");
process.env.LH_DATA_DIR = path.join(root, "data");
delete process.env.LH_IGNORE_ENV_KEYS;
for (const name of [...AUTH_PROVIDER_ENV_VARS, ...AUTH_KEYS.map((key) => key.id)]) {
	delete process.env[name];
}

const { piModels, piEngineForSpec } = await import("../src/agent/models.ts");
const { providerKeyPresent } = await import("../src/server/keys.ts");
const { oauthStore } = await import("../src/store/oauth.ts");
const { modelCatalog, catalogContextLimits, refreshConnectionCatalog } = await import("../src/server/model-catalog.ts");
after(() => fs.rmSync(root, { recursive: true, force: true }));

test("ChatGPT, account-filtered Copilot, and API-key models coexist without admitting unknown providers", async (t) => {
	const send = Object.getOwnPropertyDescriptor(process, "send");
	const connected = Object.getOwnPropertyDescriptor(process, "connected");
	const originalFetch = globalThis.fetch;
	const ambientCopilotToken = process.env.COPILOT_GITHUB_TOKEN;
	t.after(() => {
		if (send) Object.defineProperty(process, "send", send);
		else delete process.send;
		if (connected) Object.defineProperty(process, "connected", connected);
		else delete (process as { connected?: boolean }).connected;
		globalThis.fetch = originalFetch;
		delete process.env.OPENAI_API_KEY;
		if (ambientCopilotToken === undefined) delete process.env.COPILOT_GITHUB_TOKEN;
		else process.env.COPILOT_GITHUB_TOKEN = ambientCopilotToken;
	});
	globalThis.fetch = async () => { throw new Error("Catalog regression must not make network requests"); };
	process.env.COPILOT_GITHUB_TOKEN = "fake-ambient-token-must-not-authorize";

	assert.equal(providerKeyPresent("unknown-provider"), false);
	assert.equal(providerKeyPresent("chatgpt"), false);
	assert.equal(providerKeyPresent("github-copilot"), false);
	assert.equal(providerKeyPresent("openai"), false);
	assert.equal(await piModels().getAuth("github-copilot"), undefined);

	const copilotModels = piModels().getModels("github-copilot");
	const copilot = copilotModels[0]!;
	const excludedCopilot = copilotModels[1]!;
	assert(copilot && excludedCopilot, "need two native Copilot models to verify account filtering");
	const access = "tid=fake;proxy-ep=proxy.individual.githubcopilot.com;";
	await oauthStore.modify("github-copilot", async () => ({
		type: "oauth",
		access,
		refresh: "fake-refresh-token",
		expires: Date.now() + 3_600_000,
		availableModelIds: [copilot.id],
	}));
	const openai = piModels().getModels("openai").find((model) => model.api === "openai-responses")!;
	assert(openai, "need a supported native model for the ChatGPT account catalog");
	process.env.OPENAI_API_KEY = "fake-openai-api-key";

	// The desktop bridge is private IPC, not an HTTP auth endpoint. Reply with
	// one fake connected account and its model list, without acquiring a lease.
	Object.defineProperty(process, "connected", { configurable: true, value: true });
	Object.defineProperty(process, "send", {
		configurable: true,
		value: (request: { id: string; op: string }, callback?: () => void) => {
			assert.equal(request.op, "models");
			callback?.();
			queueMicrotask(() => {
				(process.emit as (name: string, value: unknown) => boolean)("message", {
					channel: "lh:chatgpt", id: request.id, op: request.op, ok: true,
					value: {
						epoch: 1, authorityRevision: 1, revision: 1,
						status: {
							available: true, pending: false, allowBackgroundUse: true,
							activeId: "fake-account",
							accounts: [{ id: "fake-account", connected: true, planEnabled: true }],
							error: null,
						},
						accountId: "fake-account",
						models: [{ id: openai.id, name: "Fake account model" }],
					},
				});
			});
			return true;
		},
	});
	await refreshConnectionCatalog();

	const catalog = modelCatalog();
	for (const provider of ["chatgpt", "github-copilot", "openai"]) {
		assert.equal(providerKeyPresent(provider), true, `${provider} auth is present`);
		assert.equal(catalog.providers.find((row) => row.id === provider)?.keyPresent, true);
		assert(catalog.models.some((model) => model.provider === provider), `${provider} models coexist`);
	}
	assert.equal(providerKeyPresent("unknown-provider"), false, "other connections must not authorize an unknown provider");
	assert.deepEqual(catalog.models.filter((model) => model.provider === "github-copilot").map((model) => model.id), [copilot.id]);
	assert.deepEqual(catalog.models.filter((model) => model.provider === "chatgpt").map((model) => model.id), [openai.id]);
	const limits = catalogContextLimits();
	assert.equal(limits.get(`chatgpt:${openai.id}`), openai.contextWindow);
	assert.equal(limits.get(`github-copilot:${copilot.id}`), copilot.contextWindow);
	assert.equal(limits.has(`github-copilot:${excludedCopilot.id}`), false);
	assert.equal(limits.get(`openai:${openai.id}`), openai.contextWindow);
	assert.equal(piEngineForSpec({ provider: "chatgpt", id: openai.id }, false).model.provider, "chatgpt");
	assert.equal(piEngineForSpec({ provider: "github-copilot", id: copilot.id }).model, copilot);
	assert.equal(piEngineForSpec({ provider: "openai", id: openai.id }).model, openai);
	assert.equal((await piModels().getAuth("github-copilot"))?.auth.apiKey, access);
	assert.equal((await piModels().getAuth("openai"))?.auth.apiKey, "fake-openai-api-key");
});
