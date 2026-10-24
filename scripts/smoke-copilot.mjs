/**
 * Packaged-server Copilot OAuth smoke. Host Node only; no GitHub account/network.
 * Run AFTER build-server.mjs: node scripts/smoke-copilot.mjs
 *
 * Boots Electron's standalone payload on 127.0.0.1 with throwaway auth/data.
 * A child-only --import preload supplies fake GitHub fetch responses and blocks
 * every other fetch/socket connection. No application auth code is replaced.
 * Exercises origin enforcement, device flow/cancel/retry, account model filtering,
 * credential persistence/permissions, safe response projections, and disconnect.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { probeEnv } from "./smoke-demo-runtime.mjs";

const STANDALONE = path.resolve(import.meta.dirname, "../.next/standalone");
const SERVER = path.join(STANDALONE, "server.js");
const AUTH_ROUTE = "/api/auth/github-copilot";
const GITHUB_TOKEN = "lh-smoke-fake-github-access-token";
const COPILOT_TOKEN = "lh-smoke-fake-copilot-access-token";
const DEVICE_CODES = ["lh-smoke-private-device-one", "lh-smoke-private-device-two"];
const SECRETS = [GITHUB_TOKEN, COPILOT_TOKEN, ...DEVICE_CODES];

function assertSafe(text, surface) {
	assert.ok(SECRETS.every((secret) => !text.includes(secret)), `${surface} exposed a fake credential`);
}

function redact(text) {
	for (const secret of SECRETS) text = text.replaceAll(secret, "[redacted]");
	return text;
}

function freePort() {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address();
			server.close((error) => error ? reject(error) : resolve(port));
		});
	});
}

/** Written only into the temporary home; never shipped with application code. */
function preloadSource({ modelId, auditFile, approvalFile }) {
	return `
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import { syncBuiltinESMExports } from "node:module";
const modelId = ${JSON.stringify(modelId)};
const auditFile = ${JSON.stringify(auditFile)};
const approvalFile = ${JSON.stringify(approvalFile)};
const githubToken = ${JSON.stringify(GITHUB_TOKEN)};
const copilotToken = ${JSON.stringify(COPILOT_TOKEN)};
const deviceCodes = ${JSON.stringify(DEVICE_CODES)};
let attempts = 0;
const record = (event) => fs.appendFileSync(auditFile, JSON.stringify({ event }) + "\\n");
const blocked = () => {
	record("blocked");
	throw new Error("smoke-copilot blocked unexpected outbound network");
};
// Covers http/https/undici transports even if code bypasses global fetch.
// Inbound HTTP and the server's listen() do not establish outbound sockets.
net.Socket.prototype.connect = blocked;
net.connect = blocked;
net.createConnection = blocked;
syncBuiltinESMExports();
globalThis.fetch = async (input, init = {}) => {
	const url = input instanceof Request ? input.url : String(input);
	const method = (init.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
	const signal = init.signal ?? (input instanceof Request ? input.signal : undefined);
	signal?.throwIfAborted();
	const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
	const json = (body) => Response.json(body);
	if (url === "https://github.com/login/device/code" && method === "POST") {
		record("device");
		assert.ok(attempts < deviceCodes.length, "unexpected third login attempt");
		const device_code = deviceCodes[attempts++];
		return json({ device_code, user_code: "SMOKE-CODE", verification_uri: "https://github.com/login/device", interval: 1, expires_in: 120 });
	}
	if (url === "https://github.com/login/oauth/access_token" && method === "POST") {
		record("oauth-token");
		const body = init.body ?? (input instanceof Request ? await input.text() : "");
		const device = new URLSearchParams(String(body)).get("device_code");
		assert.ok(deviceCodes.includes(device), "unexpected device capability");
		return device === deviceCodes[1] && fs.existsSync(approvalFile)
			? json({ access_token: githubToken, token_type: "bearer", scope: "read:user" })
			: json({ error: "authorization_pending" });
	}
	if (url === "https://api.github.com/copilot_internal/v2/token" && method === "GET") {
		record("copilot-token");
		assert.ok(headers.get("authorization") === "Bearer " + githubToken, "missing fake GitHub bearer");
		return json({ token: copilotToken, expires_at: Math.floor(Date.now() / 1000) + 3600 });
	}
	if (url === "https://api.individual.githubcopilot.com/models" && method === "GET") {
		record("models");
		assert.ok(headers.get("authorization") === "Bearer " + copilotToken, "missing fake Copilot bearer");
		return json({ data: [{ id: modelId, model_picker_enabled: true, policy: { state: "enabled" }, capabilities: { supports: { tool_calls: true } } }] });
	}
	return blocked();
};
record("preload");
`;
}

async function stop(child, exited) {
	if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
	const wait = async (ms) => {
		let timer;
		try {
			return await Promise.race([exited.then(() => true), new Promise((resolve) => { timer = setTimeout(() => resolve(false), ms); })]);
		} finally { clearTimeout(timer); }
	};
	child.kill("SIGTERM");
	if (!await wait(3000)) {
		child.kill("SIGKILL");
		if (!await wait(3000)) throw new Error("standalone child did not exit after SIGKILL");
	}
}

async function main() {
	assert.ok(fs.existsSync(SERVER), ".next/standalone/server.js missing — build the packaged server first");
	// Import the payload's own static builtin catalog, not checkout dependencies
	// or live model discovery. Pick one account-allowed model out of many.
	const catalogFile = path.join(STANDALONE, "node_modules/@earendil-works/pi-ai/dist/providers/github-copilot.models.js");
	const { GITHUB_COPILOT_MODELS } = await import(pathToFileURL(catalogFile).href);
	const ids = Object.keys(GITHUB_COPILOT_MODELS).sort();
	assert.ok(ids.length > 1, "packaged Copilot builtin catalog must contain multiple models to test filtering");
	const modelId = ids[0];
	const port = await freePort();
	const origin = `http://127.0.0.1:${port}`;
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "lh-copilot-smoke-"));
	const authFile = path.join(home, "auth.json");
	const oauthFile = path.join(home, "oauth.json");
	const auditFile = path.join(home, "network.jsonl");
	const approvalFile = path.join(home, "approve-second-login");
	const preloadFile = path.join(home, "mock-github.mjs");
	let child;
	let exited;
	let log = "";
	let interrupted = false;
	const interrupt = () => { interrupted = true; child?.kill("SIGTERM"); };
	process.on("SIGINT", interrupt);
	process.on("SIGTERM", interrupt);
	try {
		fs.writeFileSync(authFile, "{}\n", { mode: 0o600 });
		fs.writeFileSync(preloadFile, preloadSource({ modelId, auditFile, approvalFile }), { mode: 0o600 });
		const deadline = Date.now() + 30_000;
		child = spawn(process.execPath, ["--import", pathToFileURL(preloadFile).href, SERVER], {
			cwd: STANDALONE,
			env: { ...probeEnv(process.env, home), HOSTNAME: "127.0.0.1", PORT: String(port), NEXT_TELEMETRY_DISABLED: "1" },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let spawnError;
		child.once("error", (error) => { spawnError = error; });
		exited = new Promise((resolve) => child.once("exit", resolve));
		const keep = (chunk) => { log = (log + chunk.toString()).slice(-16_000); };
		child.stdout.on("data", keep);
		child.stderr.on("data", keep);
		const check = () => {
			if (interrupted) throw new Error("smoke interrupted");
			if (spawnError) throw spawnError;
			if (child.exitCode !== null || child.signalCode !== null) throw new Error("standalone child exited early");
			if (Date.now() >= deadline) throw new Error("Copilot smoke exceeded 30 seconds");
		};
		const request = (route, method = "GET", requestOrigin = origin) => {
			check();
			return new Promise((resolve, reject) => {
				const req = http.request(origin + route, { method, headers: { Origin: requestOrigin } }, (res) => {
					let text = "";
					res.setEncoding("utf8");
					res.on("data", (chunk) => { text += chunk; });
					res.once("error", reject);
					res.once("end", () => {
						try {
							assertSafe(JSON.stringify(res.headers) + text, `${method} ${route}`);
							resolve({ status: res.statusCode, text });
						} catch (error) { reject(error); }
					});
				});
				req.once("error", reject);
				req.setTimeout(Math.min(2500, Math.max(1, deadline - Date.now())), () => req.destroy(new Error("HTTP probe timed out")));
				req.end();
			});
		};
		const api = async (route, method = "GET", requestOrigin = origin, status = 200) => {
			const response = await request(route, method, requestOrigin);
			assert.equal(response.status, status, `${method} ${route}: unexpected status`);
			return JSON.parse(response.text);
		};
		const poll = async (label, action, accept) => {
			for (;;) {
				check();
				const value = await action();
				if (accept(value)) return value;
				if (["error", "expired", "cancelled"].includes(value?.state)) throw new Error(`${label}: login ended as ${value.state}`);
				await delay(100);
			}
		};
		await poll("boot", async () => {
			try { return (await request("/")).status; }
			catch (error) { if (error.code === "ECONNREFUSED" || error.code === "ECONNRESET") return 0; throw error; }
		}, (status) => status === 200);
		console.log(`[smoke-copilot] packaged host-Node server booted on ${origin}`);

		const connection = async (connected) => {
			assert.deepEqual(await api(AUTH_ROUTE), { connected });
			const keys = await api("/api/keys");
			assert.deepEqual(keys.copilot, { connected });
			const catalog = await api("/api/models");
			assert.equal(catalog.providers.find((provider) => provider.id === "github-copilot")?.keyPresent, connected);
			assert.deepEqual(catalog.models.map((model) => `${model.provider}:${model.id}`), connected ? [`github-copilot:${modelId}`] : []);
		};
		await connection(false);
		await api(`${AUTH_ROUTE}/login`, "POST", "https://foreign.invalid", 403);
		await api(`${AUTH_ROUTE}/login`, "POST", `http://localhost:${port}`, 403);
		const first = await api(`${AUTH_ROUTE}/login`, "POST");
		assert.equal(typeof first.id, "string");
		const waiting = await poll("first waiting", () => api(`${AUTH_ROUTE}/login/${first.id}`), (view) => view.state === "waiting");
		assert.equal(waiting.userCode, "SMOKE-CODE");
		assert.equal(waiting.verificationUri, "https://github.com/login/device");
		assert.equal((await api(`${AUTH_ROUTE}/login/${first.id}`, "DELETE")).state, "cancelled");
		assert.equal((await api(`${AUTH_ROUTE}/login/${first.id}`)).state, "cancelled");
		assert.ok(!fs.existsSync(oauthFile), "cancelled attempt must not persist credentials");
		await connection(false);
		console.log("[smoke-copilot] foreign origins rejected; first device flow waited and cancelled");

		const second = await api(`${AUTH_ROUTE}/login`, "POST");
		assert.notEqual(second.id, first.id);
		await poll("second waiting", () => api(`${AUTH_ROUTE}/login/${second.id}`), (view) => view.state === "waiting");
		fs.writeFileSync(approvalFile, "approve fake account\n");
		await poll("second completion", () => api(`${AUTH_ROUTE}/login/${second.id}`), (view) => view.state === "connected");
		await connection(true);
		const persisted = JSON.parse(fs.readFileSync(oauthFile, "utf8"));
		const credential = persisted["github-copilot"];
		assert.ok(credential?.type === "oauth" && credential.access === COPILOT_TOKEN && credential.refresh === GITHUB_TOKEN,
			"OAuth file must persist the fake credentials");
		assert.deepEqual(credential.availableModelIds, [modelId]);
		assert.equal(fs.statSync(oauthFile).mode & 0o777, 0o600, "OAuth file must be mode 0600");
		assert.deepEqual(JSON.parse(fs.readFileSync(authFile, "utf8")), {}, "OAuth must not modify API-key auth.json");
		await api(AUTH_ROUTE, "DELETE", "https://foreign.invalid", 403);
		await connection(true);
		console.log(`[smoke-copilot] connected; account catalog restricted to ${modelId}; private persistence verified`);

		assert.deepEqual(await api(AUTH_ROUTE, "DELETE"), { connected: false });
		await connection(false);
		assert.equal((await api(`${AUTH_ROUTE}/login/${second.id}`)).state, "cancelled");
		const after = fs.existsSync(oauthFile) ? JSON.parse(fs.readFileSync(oauthFile, "utf8")) : {};
		assert.ok(!Object.hasOwn(after, "github-copilot"), "disconnect must remove persisted credentials");
		const events = fs.readFileSync(auditFile, "utf8").trim().split("\n").map((line) => JSON.parse(line).event);
		assert.equal(events.filter((event) => event === "device").length, 2);
		for (const event of ["preload", "oauth-token", "copilot-token", "models"]) assert.ok(events.includes(event), `mock ${event} was not exercised`);
		assert.ok(!events.includes("blocked"), "application attempted unexpected outbound network (blocked)");
		console.log("[smoke-copilot] disconnected; status/catalog cleared; no response exposed fake tokens");
	} catch (error) {
		console.error("--- mocked network events ---\n" + (fs.existsSync(auditFile) ? fs.readFileSync(auditFile, "utf8") : "none"));
		console.error("--- standalone server log tail ---\n" + redact(log));
		throw error;
	} finally {
		try { if (child) await stop(child, exited); }
		finally {
			process.removeListener("SIGINT", interrupt);
			process.removeListener("SIGTERM", interrupt);
			fs.rmSync(home, { recursive: true, force: true });
		}
	}
	console.log("[smoke-copilot] passed — packaged OAuth lifecycle, isolated from real credentials/network");
}

main().catch((error) => {
	console.error(`[smoke-copilot] FAIL: ${redact(error.message)}`);
	process.exitCode = 1;
});
