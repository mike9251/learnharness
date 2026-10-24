import { configurePiCredentials, piModels } from "../agent/models.ts";
import { oauthStore } from "../store/oauth.ts";
import type { CopilotStatus } from "../core/contracts/copilot.ts";
import { createCopilotLoginManager } from "./copilot-login.ts";

export const COPILOT_PROVIDER = "github-copilot";
// Only Copilot opts in. Other providers retain their existing env-first API keys,
// even if a hand-edited OAuth file happens to contain another provider's entry.
configurePiCredentials({
	read: (id, options) => id === COPILOT_PROVIDER ? oauthStore.read(id, options) : Promise.resolve(undefined),
	list: async (options) => (await oauthStore.list(options)).filter((entry) => entry.providerId === COPILOT_PROVIDER),
	modify: (id, fn, options) => {
		if (id !== COPILOT_PROVIDER) return Promise.reject(new Error("OAuth is only enabled for GitHub Copilot"));
		return oauthStore.modify(id, fn, options);
	},
	delete: (id, options) => {
		if (id !== COPILOT_PROVIDER) return Promise.reject(new Error("OAuth is only enabled for GitHub Copilot"));
		return oauthStore.delete(id, options);
	},
});

/** Presence is deliberately local: checking settings never refreshes or pings GitHub. */
export function copilotStatus(): CopilotStatus {
	return { connected: oauthStore.readCredential(COPILOT_PROVIDER) !== undefined };
}

/** pi-ai owns the account-model filter as well as the catalog. */
export function copilotModels() {
	const credential = oauthStore.readCredential(COPILOT_PROVIDER);
	if (!credential) return [];
	const provider = piModels().getProvider(COPILOT_PROVIDER)!;
	const models = provider.getModels();
	return provider.filterModels?.(models, credential) ?? models;
}

// All route bundles / HMR imports address one login registry per installation server.
const LOGIN_KEY = Symbol.for("lh.copilotLogin");
const root = globalThis as Record<symbol, ReturnType<typeof createCopilotLoginManager> | undefined>;
export const copilotLogin = root[LOGIN_KEY] ??= createCopilotLoginManager({
	login: async (interaction) => { await piModels().login(COPILOT_PROVIDER, "oauth", interaction); },
	logout: () => piModels().logout(COPILOT_PROVIDER),
	connected: () => copilotStatus().connected,
});
