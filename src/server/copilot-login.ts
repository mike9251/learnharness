import { randomUUID } from "node:crypto";
import type { AuthInteraction } from "@earendil-works/pi-ai";
import type { CopilotLoginStatus } from "../core/contracts/copilot.ts";

// The global login manager can outlive this module after HMR/route reloads.
// A module-local instanceof check would turn its intentional 4xx errors into 500s.
const AUTH_ERROR = Symbol.for("lh.copilotAuthError");
export class CopilotAuthError extends Error {
	readonly [AUTH_ERROR] = true;
	constructor(message: string, readonly status: number) { super(message); }
}

function isCopilotAuthError(error: unknown): error is CopilotAuthError {
	if (!(error instanceof Error)) return false;
	const status = Object.getOwnPropertyDescriptor(error, "status")?.value;
	return Object.getOwnPropertyDescriptor(error, AUTH_ERROR)?.value === true &&
		typeof Object.getOwnPropertyDescriptor(error, "message")?.value === "string" &&
		typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599;
}

interface LoginSession {
	view: CopilotLoginStatus;
	controller: AbortController;
	timer?: ReturnType<typeof setTimeout>;
	task: Promise<void>;
	finishedAt?: number;
}

/** Installation-local, capability-addressed login attempts; no credentials in views. */
export function createCopilotLoginManager(deps: {
	login: (interaction: AuthInteraction) => Promise<void>;
	logout: () => Promise<void>;
	connected: () => boolean;
	timeoutMs?: number;
}) {
	const sessions = new Map<string, LoginSession>();
	let disconnecting = false;
	const pending = (s: LoginSession) => s.view.state === "starting" || s.view.state === "waiting";
	const finish = (s: LoginSession, state: CopilotLoginStatus["state"], error?: string) => {
		clearTimeout(s.timer);
		s.view = { id: s.view.id, state, ...(error ? { error } : {}) };
		s.finishedAt = Date.now();
	};
	const expire = (s: LoginSession) => {
		if (!pending(s)) return;
		finish(s, "expired", "GitHub login expired. Try connecting again.");
		s.controller.abort();
	};
	const prune = () => {
		for (const [id, s] of sessions) {
			if (s.finishedAt && (Date.now() - s.finishedAt > 300_000 || sessions.size >= 32)) sessions.delete(id);
		}
	};
	const find = (id: string) => {
		prune();
		const s = sessions.get(id);
		if (!s) throw new CopilotAuthError("Login attempt not found. Try connecting again.", 404);
		return s;
	};
	return {
		start(): CopilotLoginStatus {
			prune();
			if (disconnecting || [...sessions.values()].some(pending)) {
				throw new CopilotAuthError("A GitHub login is already in progress. Cancel it before trying again.", 409);
			}
			if (deps.connected()) throw new CopilotAuthError("GitHub Copilot is already connected.", 409);
			const s: LoginSession = {
				view: { id: randomUUID(), state: "starting" },
				controller: new AbortController(),
				task: Promise.resolve(),
			};
			const deadline = Date.now() + (deps.timeoutMs ?? 15 * 60_000);
			s.timer = setTimeout(() => expire(s), Math.max(0, deadline - Date.now()));
			s.timer.unref?.();
			sessions.set(s.view.id, s);
			s.task = Promise.resolve().then(async () => {
				await deps.login({
					signal: s.controller.signal,
					prompt: async (prompt) => {
						// pi-ai 1.4.0's sole Copilot prompt. Never answer new prompts blindly.
						if (prompt.type !== "text" || prompt.message !== "GitHub Enterprise URL/domain (blank for github.com)") {
							throw new Error("Unsupported Copilot login prompt");
						}
						return "";
					},
					notify: (event) => {
						if (!pending(s) || event.type !== "device_code") return;
						const url = new URL(event.verificationUri);
						if (url.origin !== "https://github.com" || url.username || url.password) {
							throw new Error("Unexpected GitHub verification URL");
						}
						const expiresAt = Math.min(deadline, Date.now() + (event.expiresInSeconds ?? 900) * 1000);
						s.view = { id: s.view.id, state: "waiting", userCode: event.userCode, verificationUri: url.href, expiresAt };
						clearTimeout(s.timer);
						s.timer = setTimeout(() => expire(s), Math.max(0, expiresAt - Date.now()));
						s.timer.unref?.();
					},
				});
				if (pending(s)) finish(s, "connected");
			}).catch(() => {
				// Provider response bodies may contain credentials. Never return/log them.
				if (pending(s)) finish(s, "error", "Could not connect GitHub Copilot. Check your GitHub authorization and Copilot access, then retry.");
			});
			return { ...s.view };
		},
		status(id: string): CopilotLoginStatus { return { ...find(id).view }; },
		async cancel(id: string): Promise<CopilotLoginStatus> {
			const s = find(id);
			if (pending(s)) {
				finish(s, "cancelled");
				s.controller.abort();
				await s.task;
			}
			return { ...s.view };
		},
		async disconnect(): Promise<void> {
			if (disconnecting) throw new CopilotAuthError("Disconnect is already in progress.", 409);
			disconnecting = true;
			try {
				for (const s of sessions.values()) {
					if (pending(s)) {
						finish(s, "cancelled");
						s.controller.abort();
					}
				}
				await Promise.all([...sessions.values()].map((s) => s.task));
				await deps.logout();
				// A late poll must not announce a connection that was removed.
				for (const s of sessions.values()) if (s.view.state === "connected") finish(s, "cancelled");
			} finally { disconnecting = false; }
		},
	};
}

/** Use the browser-facing Host, not NextRequest's loopback-normalized URL.
 * Never trust forwarded-host, and never equate localhost with 127.0.0.1.
 * Plain Request callers without Host retain their original URL authority.
 */
function requestOrigin(request: Request): string | undefined {
	try {
		const url = new URL(request.url);
		if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
		const host = request.headers.get("host");
		if (host === null) return url.username || url.password ? undefined : url.origin;
		// A Host must be one URL authority, not userinfo, a path, a header list,
		// or percent-encoded delimiters that URL parsing could silently normalize.
		if (!host || /[\s/@\\?#,%]/.test(host) || host.endsWith(":")) return undefined;
		const authority = new URL(`${url.protocol}//${host}`);
		if (!authority.hostname || authority.username || authority.password ||
			authority.pathname !== "/" || authority.search || authority.hash) return undefined;
		return authority.origin;
	} catch {
		return undefined;
	}
}

/** No cross-site login/logout, including against the local Electron server. */
export function requireCopilotOrigin(request: Request): void {
	const origin = request.headers.get("origin");
	const site = request.headers.get("sec-fetch-site");
	const expectedOrigin = requestOrigin(request);
	if (!expectedOrigin || site === "cross-site" || site === "same-site" ||
		(origin !== null && origin !== expectedOrigin) ||
		(request.method !== "GET" && origin === null)) {
		throw new CopilotAuthError("This request must come from LearnHarness.", 403);
	}
}

export async function copilotAuthResponse(request: Request, action: () => unknown | Promise<unknown>): Promise<Response> {
	const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
	try {
		requireCopilotOrigin(request);
		return Response.json(await action(), { headers });
	} catch (error) {
		const known = isCopilotAuthError(error);
		return Response.json({ error: known ? error.message : "Copilot authorization is unavailable. Please retry." }, {
			status: known ? error.status : 500, headers,
		});
	}
}
