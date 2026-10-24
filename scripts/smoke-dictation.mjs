/**
 * Offline, real-Chrome dictation regression gate. Build the standalone payload
 * first; this script never builds it or opens the installed app/profile.
 *
 * node scripts/smoke-dictation.mjs [--standalone <dir>] [--chrome <binary>]
 * CHROME_PATH is also accepted. macOS defaults to Google Chrome.
 *
 * Real AudioContext + oscillator MediaStream + shipped AudioWorklet; fake
 * Deepgram socket/token only. No microphone permission or real credentials.
 * Diagnostics contain counters, RMS, states, and known fixture comparisons,
 * never PCM, tokens, arbitrary browser/server logs, or composer text.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import puppeteer from "puppeteer-core";
import { probeEnv } from "./smoke-demo-runtime.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const FIXTURE = "synthetic dictation test";
const TIMEOUT = 12_000;
const args = process.argv.slice(2);
function option(name, fallback) {
	const index = args.indexOf(name);
	if (index < 0) return fallback;
	assert.ok(args[index + 1] && !args[index + 1].startsWith("--"), `${name} requires a path`);
	return path.resolve(args[index + 1]);
}
const standalone = option("--standalone", path.join(ROOT, ".next/standalone"));
const chrome = option("--chrome", process.env.CHROME_PATH || (process.platform === "darwin"
	? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "/usr/bin/google-chrome"));

async function bounded(promise, ms, label) {
	let timer;
	try {
		return await Promise.race([promise, new Promise((_, reject) => {
			timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
		})]);
	} finally { clearTimeout(timer); }
}
async function stopChild(child) {
	if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
	const exited = new Promise((resolve) => child.once("exit", resolve));
	child.kill("SIGTERM");
	try { await bounded(exited, 3000, "process shutdown"); }
	catch { child.kill("SIGKILL"); await bounded(exited, 3000, "forced process shutdown"); }
}
function freePort() {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address();
			server.close(() => resolve(port));
		});
	});
}

// Serialized into every fresh page before application JS. Native capture APIs
// are wrapped, not replaced with fake worklet messages or fake PCM buffers.
function installProbe(options) {
	const probe = window.__dictationProbe = {
		contexts: [], phases: [], microphoneCalls: 0, levels: 0, maxRms: 0,
		frames: 0, bytes: 0, partialFrames: 0, drained: 0, stopRequests: 0,
		wsCreated: 0, wsOpened: 0, wsFrames: 0, wsBytes: 0, wsPartialFrames: 0,
		closeStream: 0, framesAtClose: 0, bytesAtClose: 0, drainedAtClose: 0,
		audioAfterClose: 0, invalidSends: 0, fixtureResults: 0, emptyResults: 0,
		stopClicked: false, openedAtStop: null, framesAtStop: 0,
		deferredBeforeStop: false, fixtureWrites: 0,
	};
	const NativeContext = window.AudioContext;
	const inputs = [];
	window.__stopDictationProbeInputs = async () => {
		await Promise.all(inputs.map(async ({ context, oscillator, destination }) => {
			oscillator.stop();
			destination.stream.getTracks().forEach((track) => track.stop());
			await context.close();
		}));
	};
	navigator.mediaDevices.getUserMedia = async () => {
		probe.microphoneCalls++;
		// Resume synchronously in the Start gesture, before the artificial
		// permission delay. Neither graph ever connects the tone to speakers.
		const context = new NativeContext();
		const oscillator = context.createOscillator();
		oscillator.frequency.value = 440;
		const gain = context.createGain();
		gain.gain.value = options.silent ? 0 : 0.2;
		const destination = context.createMediaStreamDestination();
		oscillator.connect(gain).connect(destination);
		oscillator.start();
		inputs.push({ context, oscillator, destination });
		await context.resume();
		await new Promise((resolve) => setTimeout(resolve, 250));
		return destination.stream;
	};
	window.AudioContext = new Proxy(NativeContext, {
		construct(Target, args) {
			const context = new Target(...args);
			const metadata = { sampleRate: context.sampleRate, state: context.state };
			probe.contexts.push(metadata);
			context.addEventListener("statechange", () => { metadata.state = context.state; });
			return context;
		},
	});
	// Count only writes of the known fixture, never retain arbitrary text.
	const value = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");
	Object.defineProperty(HTMLTextAreaElement.prototype, "value", {
		...value,
		set(text) {
			if (text === options.fixture) probe.fixtureWrites++;
			value.set.call(this, text);
		},
	});
	const status = () => document.querySelector('[data-testid="dictation-bar"] [role="status"]')?.textContent;
	const phaseLabels = ["Starting microphone…", "Connecting…", "Listening…", "Finishing…"];
	new MutationObserver(() => {
		const label = status();
		if (phaseLabels.includes(label) && probe.phases.at(-1) !== label) probe.phases.push(label);
	}).observe(document, { subtree: true, childList: true, characterData: true });

	window.AudioWorkletNode = new Proxy(window.AudioWorkletNode, {
		construct(Target, args) {
			const node = new Target(...args);
			const post = node.port.postMessage.bind(node.port);
			node.port.postMessage = (...messages) => {
				if (messages[0]?.type === "stop") probe.stopRequests++;
				return post(...messages);
			};
			node.port.addEventListener("message", ({ data }) => {
				if (data.type === "audio") {
					const size = data.buffer?.byteLength ?? 0;
					probe.frames++;
					probe.bytes += size;
					if (size > 0 && size < 4096) probe.partialFrames++;
				} else if (data.type === "stopped") probe.drained++;
				else if (data.type === "level") {
					probe.levels++;
					probe.maxRms = Math.max(probe.maxRms, data.rms ?? 0);
					// Stop between full-frame boundaries, using real capture progress
					// rather than wall-clock sleeps. OS scheduling can still land on
					// a boundary; the runner allows three fresh attempts for a tail.
					const ready = options.delayed ? status() === "Connecting…" && probe.wsCreated === 1 && probe.wsOpened === 0
						: status() === "Listening…" && (options.empty || probe.fixtureResults === 1);
					if (!probe.stopClicked && ready && probe.frames >= 3 && probe.levels % 16 === 8) {
						probe.stopClicked = true;
						probe.openedAtStop = probe.wsOpened;
						probe.framesAtStop = probe.frames;
						probe.deferredBeforeStop = document.querySelector('textarea[placeholder="What do you want to learn?"]')?.value === "";
						document.querySelector('[data-testid="dictation-toggle"]')?.click();
					}
				}
			});
			return node;
		},
	});

	class FakeSocket extends EventTarget {
		static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
		readyState = 0;
		closedStream = false;
		sentResult = false;
		constructor(url) {
			super();
			if (!String(url).startsWith("wss://api.deepgram.com/")) throw new Error("Unexpected socket in offline probe");
			probe.wsCreated++;
			setTimeout(() => {
				if (this.readyState !== 0) return;
				this.readyState = 1;
				probe.wsOpened++;
				this.dispatchEvent(new Event("open"));
			}, options.delayed ? 1200 : 250);
		}
		result(text) {
			if (text) probe.fixtureResults++;
			else probe.emptyResults++;
			this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({
				type: "Results", is_final: true, channel: { alternatives: [{ transcript: text }] },
			}) }));
		}
		send(data) {
			if (typeof data !== "string" && this.closedStream) probe.audioAfterClose++;
			if (this.readyState !== 1) { probe.invalidSends++; throw new Error("Fake socket is not open"); }
			if (typeof data !== "string") {
				const size = data.byteLength ?? 0;
				probe.wsFrames++;
				probe.wsBytes += size;
				if (size > 0 && size < 4096) probe.wsPartialFrames++;
				// A final before Stop proves the composer remains deferred.
				if (!options.empty && !this.sentResult) { this.sentResult = true; this.result(options.fixture); }
				return;
			}
			if (JSON.parse(data).type !== "CloseStream") throw new Error("Unexpected socket control message");
			this.closedStream = true;
			probe.closeStream++;
			probe.framesAtClose = probe.frames;
			probe.bytesAtClose = probe.bytes;
			probe.drainedAtClose = probe.drained;
			setTimeout(() => {
				if (this.readyState !== 1) return;
				this.result("");
				this.close();
			}, 150);
		}
		close() {
			if (this.readyState === 3) return;
			this.readyState = 3;
			this.dispatchEvent(new CloseEvent("close", { code: 1000 }));
		}
	}
	window.WebSocket = FakeSocket;
}

async function runCase(browser, origin, scenario) {
	const page = await browser.newPage();
	page.setDefaultTimeout(TIMEOUT);
	let pageErrors = 0;
	let blockedRequests = 0;
	let tokenRequests = 0;
	page.on("pageerror", () => { pageErrors++; });
	try {
		await page.setViewport({ width: 1280, height: 900 });
		await page.setRequestInterception(true);
		page.on("request", (request) => {
			const url = new URL(request.url());
			let operation;
			if (url.origin === origin && url.pathname === "/api/stt/token") {
				tokenRequests++;
				operation = request.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ token: "fake-token-no-credentials" }) });
			} else if ((url.origin === origin && ["GET", "HEAD"].includes(request.method())) || ["data:", "blob:", "about:"].includes(url.protocol)) {
				operation = request.continue();
			} else { blockedRequests++; operation = request.abort(); }
			void operation.catch(() => {}); // page teardown may cancel an intercepted request
		});
		await page.evaluateOnNewDocument(installProbe, { ...scenario, fixture: FIXTURE });
		await page.goto(origin, { waitUntil: "domcontentloaded", timeout: TIMEOUT });
		await page.waitForSelector('textarea[placeholder="What do you want to learn?"]');
		await page.waitForSelector('[data-testid="dictation-toggle"][aria-label="Start dictation"]');
		await page.click('[data-testid="dictation-toggle"]');
		await page.waitForFunction(() => window.__dictationProbe.stopClicked && window.__dictationProbe.closeStream === 1
			&& !document.querySelector('[data-testid="dictation-bar"]'), { timeout: TIMEOUT });
		// Observe beyond socket close to catch late frames, duplicate commits,
		// or a capture graph that was left running. This is a bounded quiet gate.
		const before = await page.evaluate(() => ({ frames: window.__dictationProbe.frames, wsFrames: window.__dictationProbe.wsFrames }));
		await delay(250);
		const result = await page.evaluate((fixture) => {
			const probe = window.__dictationProbe;
			const button = document.querySelector('[data-testid="dictation-toggle"]');
			const text = document.querySelector('textarea[placeholder="What do you want to learn?"]')?.value;
			const error = button?.getAttribute("aria-label") ?? "";
			return { ...probe, fixtureExactlyOnce: text === fixture, composerEmpty: text === "",
				silenceError: error.startsWith("Dictation failed: Chrome supplied silent microphone audio."),
				noTranscriptError: error.startsWith("Dictation failed: No speech was transcribed."),
				visibleError: !!button?.querySelector("span.truncate")?.textContent?.includes("."),
				idleWithoutError: error === "Start dictation" };
		}, FIXTURE);
		assert.equal(pageErrors, 0, `${scenario.name}: browser page error count`);
		assert.ok(tokenRequests > 0, `${scenario.name}: fake token endpoint used`);
		assert.equal(result.microphoneCalls, 1);
		assert.equal(result.contexts.length, 1, "real application AudioContext constructed");
		assert.ok(result.contexts[0].sampleRate > 0);
		assert.ok(result.levels > 0 && result.frames >= 3, "real worklet emitted levels and PCM");
		assert.equal(result.contexts[0].state, "running");
		assert.deepEqual(result.phases, scenario.delayed
			? ["Starting microphone…", "Connecting…", "Finishing…"]
			: ["Starting microphone…", "Connecting…", "Listening…", "Finishing…"]);
		assert.equal(result.openedAtStop, scenario.delayed ? 0 : 1);
		assert.ok(result.framesAtStop >= 3, "Stop followed actual capture, not just a timer");
		assert.equal(result.deferredBeforeStop, true, "no transcript before Stop");
		assert.equal(result.wsCreated, 1);
		assert.equal(result.wsOpened, 1);
		assert.equal(result.stopRequests, 1);
		assert.equal(result.drained, 1);
		assert.equal(result.drainedAtClose, 1, "real worklet drain ACK precedes CloseStream");
		assert.equal(result.wsFrames, result.frames, "all captured/queued frames sent");
		assert.equal(result.wsBytes, result.bytes, "all captured/queued bytes sent");
		assert.equal(result.wsPartialFrames, result.partialFrames);
		assert.equal(result.framesAtClose, result.frames, "no capture after CloseStream");
		assert.equal(result.bytesAtClose, result.bytes);
		assert.equal(result.closeStream, 1);
		assert.equal(result.audioAfterClose, 0);
		assert.equal(result.invalidSends, 0);
		assert.equal(result.frames, before.frames, "capture remains stopped after finalization");
		assert.equal(result.wsFrames, before.wsFrames, "no late sends after finalization");
		if (scenario.empty) {
			assert.equal(result.emptyResults, 1);
			assert.equal(result.fixtureResults, 0);
			assert.equal(result.composerEmpty, true);
			assert.equal(result.fixtureWrites, 0);
			assert.equal(result.visibleError, true);
			assert.equal(result.idleWithoutError, false);
			assert.equal(scenario.silent ? result.silenceError : result.noTranscriptError, true);
		} else {
			assert.equal(result.fixtureResults, 1);
			assert.equal(result.fixtureExactlyOnce, true);
			assert.equal(result.fixtureWrites, 1, "one deferred composer append");
			assert.equal(result.idleWithoutError, true);
		}
		assert.ok(scenario.silent ? result.maxRms <= 0.000001 : result.maxRms > 0.01, "synthetic input RMS matches scenario");
		console.log(`[smoke-dictation] ${scenario.name} ${JSON.stringify({
			phases: result.phases, frames: result.frames, bytes: result.bytes,
			partialFrames: result.partialFrames, maxRms: result.maxRms,
			openedAtStop: result.openedAtStop, drained: result.drained,
			audioAfterClose: result.audioAfterClose, fixtureWrites: result.fixtureWrites,
			silenceError: result.silenceError, noTranscriptError: result.noTranscriptError, blockedRequests,
		})}`);
		return result.partialFrames > 0;
	} catch (error) {
		// Never stringify page errors, requests, DOM, or server logs.
		const metadata = await page.evaluate(() => window.__dictationProbe).catch(() => null);
		console.error(`[smoke-dictation] ${scenario.name} metadata ${JSON.stringify({ metadata, pageErrors, blockedRequests, tokenRequests })}`);
		throw error;
	} finally {
		await bounded(page.evaluate(() => window.__stopDictationProbeInputs?.()).catch(() => {}), 2000, "synthetic input cleanup").catch(() => {});
		await bounded(page.close(), 3000, "page cleanup");
	}
}

async function main() {
	assert.ok(fs.existsSync(path.join(standalone, "server.js")), "standalone payload missing; build it before this probe");
	assert.ok(fs.existsSync(chrome), "Chrome missing; supply --chrome or CHROME_PATH");
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "lh-smoke-dictation-"));
	let child;
	let browser;
	let spawnFailed = false;
	const cleanup = async () => {
		try {
			if (browser) {
				try { await bounded(browser.close(), 5000, "browser shutdown"); }
				finally { await stopChild(browser.process()); }
			}
		} finally {
			try { await stopChild(child); }
			finally { fs.rmSync(home, { recursive: true, force: true }); }
		}
	};
	const interrupted = () => { void cleanup().finally(() => process.exit(130)); };
	process.once("SIGINT", interrupted);
	process.once("SIGTERM", interrupted);
	try {
		fs.writeFileSync(path.join(home, "auth.json"), "{}\n", { mode: 0o600 });
		// Defense in depth: block server-side external TCP too (including
		// undici/fetch), not merely the browser's HTTP interception. No keys
		// survive probeEnv, and this guard is confined to the temporary child.
		const guard = path.join(home, "offline.cjs");
		fs.writeFileSync(guard, `const net = require('node:net');
const original = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const host = typeof first === 'object' ? first.host : typeof args[1] === 'string' ? args[1] : 'localhost';
  if (!['127.0.0.1', '::1', 'localhost'].includes(host ?? 'localhost')) throw new Error('Offline probe blocked external TCP');
  return original.apply(this, args);
};\n`);
		const port = await freePort();
		const origin = `http://127.0.0.1:${port}`;
		child = spawn(process.execPath, ["--require", guard, path.join(standalone, "server.js")], {
			cwd: standalone,
			env: { ...probeEnv(process.env, home), PORT: String(port), HOSTNAME: "127.0.0.1", NEXT_TELEMETRY_DISABLED: "1" },
			stdio: "ignore",
		});
		child.on("error", () => { spawnFailed = true; });
		const deadline = Date.now() + 30_000;
		let ready = false;
		while (Date.now() < deadline) {
			assert.ok(!spawnFailed && child.exitCode === null && child.signalCode === null, "standalone server exited before readiness");
			try {
				const response = await fetch(origin, { signal: AbortSignal.timeout(1500) });
				await response.body?.cancel();
				if (response.ok) { ready = true; break; }
			} catch { /* bounded local boot retry */ }
			await delay(100);
		}
		assert.ok(ready, "standalone server did not become ready within 30 seconds");
		browser = await puppeteer.launch({
			executablePath: chrome, headless: true, userDataDir: path.join(home, "chrome"),
			env: probeEnv(process.env, home), timeout: 15_000, protocolTimeout: TIMEOUT,
			args: ["--disable-background-networking", "--disable-component-update", "--disable-sync", "--no-first-run", "--no-proxy-server",
				// Block DNS for everything but loopback, including background tabs.
				"--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost"],
		});
		for (const scenario of [
			{ name: "normal", silent: false, empty: false, delayed: false },
			{ name: "stop-before-open", silent: false, empty: false, delayed: true },
			{ name: "silent-empty-results", silent: true, empty: true, delayed: false },
			{ name: "audible-empty-results", silent: false, empty: true, delayed: false },
		]) {
			let partial = false;
			for (let attempt = 0; attempt < 3 && !partial; attempt++) partial = await runCase(browser, origin, scenario);
			assert.ok(partial, `${scenario.name}: no partial-frame drain observed in three bounded real-capture attempts`);
		}
		console.log("[smoke-dictation] PASS: real worklet capture/drain, queued startup audio, deferred append, and visible empty-result errors (offline)");
	} finally {
		process.removeListener("SIGINT", interrupted);
		process.removeListener("SIGTERM", interrupted);
		await cleanup();
	}
}

main().catch((error) => {
	// Assertions are authored above and carry metadata only; suppress arbitrary
	// browser/runtime error messages which might include page or response text.
	console.error(`[smoke-dictation] FAIL: ${error instanceof assert.AssertionError ? error.message : error?.name ?? "Error"}`);
	process.exitCode = 1;
});
