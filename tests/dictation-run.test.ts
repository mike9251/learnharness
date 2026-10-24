import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { describe, it, type TestContext } from "node:test";
import {
	DictationRun,
	DICTATION_DRAIN_MS,
	DICTATION_FINAL_MS,
	DICTATION_SETUP_MS,
	type DictationPhase,
	type DictationRunOptions,
} from "../components/dictation-run.ts";

// Browser-boundary doubles only: no microphone, network, credentials, React, or
// access to the engine's private state. PCM and transcripts are synthetic.
class FakeTrack extends EventTarget {
	stops = 0;
	stop() { this.stops++; }
}
class FakeStream {
	readonly track = new FakeTrack();
	getTracks() { return [this.track]; }
}
class FakeSource {
	connections = 0;
	disconnections = 0;
	connect() { this.connections++; }
	disconnect() { this.disconnections++; }
}
class FakeContext extends EventTarget {
	state: AudioContextState = "suspended";
	readonly destination = {};
	readonly source = new FakeSource();
	resumes = 0;
	resume() { this.resumes++; this.state = "running"; return Promise.resolve(); }
	createMediaStreamSource() { return this.source; }
}
type PortMessage = { type: string; buffer?: ArrayBuffer | ArrayBufferView; rms?: number; requestId?: number };
class FakePort {
	onmessage: ((event: { data: PortMessage }) => void) | null = null;
	readonly sent: unknown[] = [];
	closes = 0;
	postMessage(message: unknown) { this.sent.push(message); }
	close() { this.closes++; }
	emit(data: PortMessage) { this.onmessage?.({ data }); }
}
class FakeWorklet extends EventTarget {
	readonly port = new FakePort();
	connections = 0;
	disconnections = 0;
	connect() { this.connections++; }
	disconnect() { this.disconnections++; }
}
class FakeSocket extends EventTarget {
	readyState = 0;
	readonly sent: (string | ArrayBuffer)[] = [];
	closes = 0;
	onSend?: (data: string | ArrayBuffer) => void;
	send(data: string | ArrayBuffer) {
		assert.equal(this.readyState, 1, "send requires an open socket");
		this.onSend?.(data);
		this.sent.push(data);
	}
	close() { this.closes++; this.readyState = 3; }
	open() { this.readyState = 1; this.dispatchEvent(new Event("open")); }
	message(data: unknown) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(data) })); }
	result(text: string, final = true) {
		this.message({ type: "Results", is_final: final, channel: { alternatives: [{ transcript: text }] } });
	}
	serverClose(code = 1000) {
		this.readyState = 3;
		this.dispatchEvent(Object.assign(new Event("close"), { code }));
	}
}
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}
// Drain only promise continuations; clock advancement is always explicit.
async function settle() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
function harness(t: TestContext, overrides: Partial<DictationRunOptions> = {}) {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const stream = new FakeStream();
	const ctx = new FakeContext();
	const worklet = new FakeWorklet();
	const sockets: FakeSocket[] = [];
	const tokens: boolean[] = [];
	const credentials: string[] = [];
	const phases: DictationPhase[] = [];
	const levels: number[] = [];
	const transcripts: string[] = [];
	const ends: (string | null)[] = [];
	const calls: string[] = [];
	const run = new DictationRun({
		microphone: () => { calls.push("microphone"); return Promise.resolve(stream as unknown as MediaStream); },
		audioGraph: () => { calls.push("graph"); return { ctx: ctx as unknown as AudioContext, module: Promise.resolve() }; },
		worklet: () => worklet as unknown as AudioWorkletNode,
		token: async (fresh) => { calls.push("token"); tokens.push(fresh); return fresh ? "synthetic-fresh" : "synthetic-initial"; },
		socket: (token) => {
			credentials.push(token);
			const socket = new FakeSocket();
			sockets.push(socket);
			return socket as unknown as WebSocket;
		},
		onPhase: (phase) => phases.push(phase),
		onLevel: (level) => levels.push(level),
		onTranscript: (text) => transcripts.push(text),
		onEnd: (error) => ends.push(error),
		...overrides,
	});
	t.after(() => run.cancel());
	return {
		run, stream, ctx, worklet, sockets, tokens, credentials, phases, levels, transcripts, ends, calls,
		async connecting() {
			run.start(); await settle();
			assert.equal(sockets.length, 1);
			const socket = sockets[0];
			assert.ok(socket);
			return socket;
		},
		async recording() { const socket = await this.connecting(); socket.open(); return socket; },
		ack() { worklet.port.emit({ type: "stopped", requestId: 1 }); },
	};
}
type Harness = ReturnType<typeof harness>;
const closeStream = JSON.stringify({ type: "CloseStream" });
function assertReleased(h: Harness) {
	assert.equal(h.stream.track.stops, 1, "hardware is stopped exactly once");
	assert.equal(h.worklet.port.onmessage, null);
	assert.equal(h.worklet.port.closes, 1);
	assert.equal(h.worklet.disconnections, 1);
	assert.equal(h.ctx.source.disconnections, 1);
	for (const [target, events] of [
		[h.stream.track, ["ended"]],
		[h.ctx, ["statechange"]],
		[h.worklet, ["processorerror"]],
		...h.sockets.map((socket) => [socket, ["open", "message", "close", "error"]] as const),
	] as const) {
		for (const event of events) assert.equal(getEventListeners(target, event).length, 0, `${event} listener released`);
	}
	for (const socket of h.sockets) assert.equal(socket.closes, 1);
}

describe("DictationRun", () => {
	it("starts token, microphone, and resumed graph synchronously; stages microphone → connecting → recording", async (t) => {
		const mic = deferred<MediaStream>();
		let micRequested = false;
		const h = harness(t, { microphone: () => { micRequested = true; return mic.promise; } });
		h.run.start();
		assert.equal(micRequested, true);
		assert.deepEqual(h.phases, ["microphone"]);
		assert.deepEqual(h.calls, ["token", "graph"]);
		assert.equal(h.ctx.resumes, 1, "resume happens before permission resolves");
		assert.equal(h.sockets.length, 0);
		mic.resolve(h.stream as unknown as MediaStream);
		await settle();
		assert.deepEqual(h.phases, ["microphone", "connecting"]);
		assert.equal(h.ctx.source.connections, 1);
		assert.equal(h.worklet.connections, 1);
		assert.ok(h.sockets[0]);
		h.sockets[0].open();
		assert.deepEqual(h.phases, ["microphone", "connecting", "recording"]);
		h.worklet.port.emit({ type: "level", rms: 0.25 });
		assert.deepEqual(h.levels, [0.25]);
	});

	it("defers final transcripts until Stop completion, ignores interim results, and appends once", async (t) => {
		const h = harness(t);
		const ws = await h.recording();
		ws.result("interim", false);
		ws.result("synthetic first");
		ws.result("   ");
		ws.message({ type: "Metadata", channel: { alternatives: [{ transcript: "not a result" }] } });
		assert.deepEqual(h.transcripts, []);
		h.run.stop();
		assert.deepEqual(h.transcripts, []);
		assert.deepEqual(ws.sent, [], "CloseStream must await worklet acknowledgment");
		h.ack();
		assert.deepEqual(ws.sent, [closeStream]);
		ws.result("synthetic last");
		assert.deepEqual(h.transcripts, []);
		ws.serverClose();
		await h.run.finished;
		assert.deepEqual(h.transcripts, ["synthetic first synthetic last"]);
		assert.deepEqual(h.ends, [null]);
		h.run.stop(); h.run.cancel(); ws.result("late"); ws.serverClose();
		t.mock.timers.runAll();
		assert.deepEqual(h.transcripts, ["synthetic first synthetic last"]);
		assert.deepEqual(h.ends, [null]);
		assertReleased(h);
	});

	it("Stop while connecting stops hardware and drains full + partial PCM before CloseStream on open", async (t) => {
		const h = harness(t);
		const ws = await h.connecting();
		const oldCallback = h.worklet.port.onmessage!;
		const full = new Int16Array(2048).fill(123);
		const backing = new Int16Array([999, 12, 34, 999]);
		const partial = backing.subarray(1, 3);
		h.worklet.port.emit({ type: "audio", buffer: full });
		h.run.stop(); h.run.stop();
		assert.equal(h.stream.track.stops, 1);
		assert.equal(h.ctx.source.disconnections, 1);
		assert.deepEqual(h.worklet.port.sent, [{ type: "stop", requestId: 1 }]);
		assert.equal(h.worklet.port.closes, 0, "port stays alive for the partial frame");
		h.worklet.port.emit({ type: "audio", buffer: partial });
		h.worklet.port.emit({ type: "stopped", requestId: 99 });
		assert.equal(h.worklet.port.closes, 0, "unmatched acknowledgments are ignored");
		h.ack();
		assert.equal(h.worklet.port.closes, 1);
		assert.deepEqual(ws.sent, []);
		ws.open();
		assert.equal(ws.sent.length, 3);
		assert.deepEqual(ws.sent[0], full.buffer);
		assert.deepEqual(ws.sent[1], new Int16Array([12, 34]).buffer);
		assert.equal(ws.sent[2], closeStream);
		assert.deepEqual(h.phases, ["microphone", "connecting", "stopping"]);
		oldCallback({ data: { type: "audio", buffer: new Int16Array([7]) } });
		oldCallback({ data: { type: "level", rms: 1 } });
		oldCallback({ data: { type: "stopped", requestId: 1 } });
		assert.equal(ws.sent.length, 3, "no PCM or duplicate CloseStream after close request");
		assert.deepEqual(h.levels, []);
		ws.result("synthetic drained result");
		ws.serverClose();
		await h.run.finished;
		assert.deepEqual(h.transcripts, ["synthetic drained result"]);
		assertReleased(h);
	});

	it("Stop with an open socket still waits for the ordered final-frame/ack pair", async (t) => {
		const h = harness(t);
		const ws = await h.recording();
		h.run.stop();
		h.worklet.port.emit({ type: "audio", buffer: new Int16Array([1, 2]) });
		assert.deepEqual(ws.sent, [new Int16Array([1, 2]).buffer]);
		h.ack();
		assert.equal(ws.sent.at(-1), closeStream);
	});

	for (const stopping of [false, true]) {
		it(`Escape/cancel discards finals and invalidates old callbacks (${stopping ? "stopping" : "recording"})`, async (t) => {
			const h = harness(t);
			const ws = await h.recording();
			const oldCallback = h.worklet.port.onmessage!;
			ws.result("must be discarded");
			if (stopping) h.run.stop();
			h.run.cancel();
			await h.run.finished;
			oldCallback({ data: { type: "audio", buffer: new Int16Array([1]) } });
			ws.open(); ws.result("late result"); ws.serverClose(1006);
			t.mock.timers.runAll();
			assert.deepEqual(h.transcripts, []);
			assert.deepEqual(h.ends, [null]);
			assert.equal(h.phases.at(-1), "idle");
			assert.deepEqual(h.tokens, [false]);
			assert.deepEqual(ws.sent, []);
			assertReleased(h);
		});
	}

	it("bounds blocked microphone startup and stops a microphone granted after timeout", async (t) => {
		const mic = deferred<MediaStream>();
		const h = harness(t, { microphone: () => mic.promise });
		h.run.start();
		t.mock.timers.tick(DICTATION_SETUP_MS - 1);
		assert.deepEqual(h.ends, []);
		t.mock.timers.tick(1);
		await h.run.finished;
		assert.match(h.ends[0]!, /microphone startup timed out/i);
		mic.resolve(h.stream as unknown as MediaStream);
		await settle();
		assert.equal(h.stream.track.stops, 1);
		assert.equal(h.worklet.connections, 0);
		assert.equal(h.sockets.length, 0);
		assert.deepEqual(h.phases, ["microphone", "idle"]);
	});

	it("cancel during blocked startup also stops a late microphone without starting capture", async (t) => {
		const mic = deferred<MediaStream>();
		const h = harness(t, { microphone: () => mic.promise });
		h.run.start(); h.run.cancel();
		mic.resolve(h.stream as unknown as MediaStream);
		await settle();
		t.mock.timers.runAll();
		assert.equal(h.stream.track.stops, 1);
		assert.equal(h.sockets.length, 0);
		assert.deepEqual(h.ends, [null]);
	});

	it("bounds connecting even after Stop has drained and released the worklet", async (t) => {
		const h = harness(t);
		await h.connecting();
		h.run.stop(); h.ack();
		t.mock.timers.tick(DICTATION_SETUP_MS);
		await h.run.finished;
		assert.match(h.ends[0]!, /connect.*deepgram.*time/i);
		assertReleased(h);
	});

	it("worklet processorerror ends capture and keeps already completed text", async (t) => {
		const h = harness(t);
		const ws = await h.recording();
		ws.result("synthetic completed text");
		h.worklet.dispatchEvent(new Event("processorerror"));
		await h.run.finished;
		assert.match(h.ends[0]!, /audio processor failed/i);
		assert.deepEqual(h.transcripts, ["synthetic completed text"]);
		assertReleased(h);
	});

	for (const failure of ["close", "error"] as const) {
		it(`a stopped run never reconnects or returns to recording after socket ${failure}`, async (t) => {
			const h = harness(t);
			const ws = await h.connecting();
			h.run.stop();
			if (failure === "close") ws.serverClose(1006);
			else ws.dispatchEvent(new Event("error"));
			await h.run.finished;
			ws.open();
			await settle();
			assert.deepEqual(h.tokens, [false]);
			assert.equal(h.sockets.length, 1);
			assert.deepEqual(h.phases, ["microphone", "connecting", "stopping", "idle"]);
			assert.match(h.ends[0]!, /connection.*(closed|failed)/i);
			assertReleased(h);
		});
	}

	it("active failure reconnects only once with a fresh token, retires old listeners, and flushes queued PCM", async (t) => {
		const h = harness(t);
		const old = await h.recording();
		old.result("before reconnect");
		old.serverClose(1006);
		for (const type of ["open", "message", "close", "error"]) assert.equal(getEventListeners(old, type).length, 0);
		h.worklet.port.emit({ type: "audio", buffer: new Int16Array([3, 4]) });
		old.open(); old.result("stale result"); old.dispatchEvent(new Event("error"));
		await settle();
		assert.deepEqual(h.tokens, [false, true]);
		assert.deepEqual(h.credentials, ["synthetic-initial", "synthetic-fresh"]);
		assert.equal(h.sockets.length, 2);
		const current = h.sockets[1];
		assert.ok(current);
		current.open();
		assert.deepEqual(current.sent, [new Int16Array([3, 4]).buffer]);
		assert.deepEqual(h.phases, ["microphone", "connecting", "recording", "connecting", "recording"]);
		current.result("after reconnect");
		current.dispatchEvent(new Event("error"));
		await h.run.finished;
		await settle();
		assert.deepEqual(h.tokens, [false, true]);
		assert.deepEqual(h.transcripts, ["before reconnect after reconnect"]);
		assert.match(h.ends[0]!, /connection failed/i);
		assertReleased(h);
	});

	it("bounds worklet drain wait, retains completed text, and never closes the stream before acknowledgment", async (t) => {
		const h = harness(t);
		const ws = await h.recording();
		ws.result("completed before drain");
		h.run.stop();
		t.mock.timers.tick(DICTATION_DRAIN_MS - 1);
		assert.deepEqual(h.ends, []);
		t.mock.timers.tick(1);
		await h.run.finished;
		assert.match(h.ends[0]!, /capture could not finish cleanly/i);
		assert.deepEqual(h.transcripts, ["completed before drain"]);
		assert.deepEqual(ws.sent, []);
		assertReleased(h);
	});

	it("bounds final-result wait and appends completed text exactly once", async (t) => {
		const h = harness(t);
		const ws = await h.recording();
		ws.result("completed before final wait");
		h.run.stop(); h.ack();
		t.mock.timers.tick(DICTATION_FINAL_MS - 1);
		assert.deepEqual(h.ends, []);
		t.mock.timers.tick(1);
		await h.run.finished;
		assert.match(h.ends[0]!, /timed out.*final transcription/i);
		assert.deepEqual(h.transcripts, ["completed before final wait"]);
		ws.result("too late"); ws.serverClose();
		t.mock.timers.runAll();
		assert.equal(h.transcripts.length, 1);
		assert.equal(h.ends.length, 1);
		assertReleased(h);
	});

	for (const scenario of [
		{ name: "no frames", frames: false, rms: 0.1, error: /no microphone audio was captured/i },
		{ name: "silent frames", frames: true, rms: 0, error: /silent microphone audio/i },
		{ name: "normal-RMS speech without a result", frames: true, rms: 0.1, error: /no speech was transcribed/i },
	]) {
		it(`valid completion without a final distinguishes ${scenario.name}`, async (t) => {
			const h = harness(t);
			const ws = await h.recording();
			h.worklet.port.emit({ type: "level", rms: scenario.rms });
			if (scenario.frames) h.worklet.port.emit({ type: "audio", buffer: new Int16Array([0, 0]) });
			ws.result("not final", false);
			h.run.stop(); h.ack(); ws.serverClose();
			await h.run.finished;
			assert.match(h.ends[0]!, scenario.error);
			assert.deepEqual(h.transcripts, []);
			assertReleased(h);
		});
	}

	it("Stop before the initial token resolves still drains and sends queued audio before CloseStream", async (t) => {
		const token = deferred<string>();
		const h = harness(t, { token: () => token.promise });
		h.run.start();
		await settle();
		assert.deepEqual(h.phases, ["microphone", "connecting"]);
		assert.equal(h.sockets.length, 0);
		h.worklet.port.emit({ type: "audio", buffer: new Int16Array([42]) });
		h.run.stop(); h.ack();
		token.resolve("synthetic-late-token");
		await settle();
		const ws = h.sockets[0];
		assert.ok(ws);
		ws.open();
		assert.deepEqual(ws.sent, [new Int16Array([42]).buffer, closeStream]);
		assert.equal(h.phases.includes("recording"), false);
		ws.result("synthetic late-token result"); ws.serverClose();
		await h.run.finished;
		assert.deepEqual(h.transcripts, ["synthetic late-token result"]);
		assertReleased(h);
	});

	it("cancel while a fresh reconnect token is pending prevents any replacement socket", async (t) => {
		const token = deferred<string>();
		const calls: boolean[] = [];
		const h = harness(t, { token: (fresh) => {
			calls.push(fresh);
			return fresh ? token.promise : Promise.resolve("synthetic-initial");
		} });
		const ws = await h.recording();
		ws.serverClose(1006);
		h.run.cancel();
		token.resolve("synthetic-unused");
		await settle();
		t.mock.timers.runAll();
		assert.deepEqual(calls, [false, true]);
		assert.equal(h.sockets.length, 1);
		assert.deepEqual(h.ends, [null]);
		assertReleased(h);
	});

	it("synchronous PCM send failure reconnects once without losing the unsent frame", async (t) => {
		const h = harness(t);
		const ws = await h.recording();
		ws.onSend = () => { throw new Error("synthetic send failure"); };
		h.worklet.port.emit({ type: "audio", buffer: new Int16Array([5, 6]) });
		await settle();
		const replacement = h.sockets[1];
		assert.ok(replacement);
		replacement.open();
		assert.deepEqual(replacement.sent, [new Int16Array([5, 6]).buffer]);
		assert.deepEqual(h.tokens, [false, true]);
		h.run.cancel();
		assertReleased(h);
	});

	for (const failure of ["audio", "close-stream"] as const) {
		it(`synchronous ${failure} send failure after Stop ends cleanly without reconnecting`, async (t) => {
			const h = harness(t);
			const ws = await h.recording();
			ws.result("completed before send failure");
			ws.onSend = () => { throw new Error("synthetic stopped send failure"); };
			h.run.stop();
			if (failure === "audio") h.worklet.port.emit({ type: "audio", buffer: new Int16Array([1]) });
			else h.ack();
			await h.run.finished;
			await settle();
			assert.deepEqual(h.tokens, [false]);
			assert.deepEqual(h.transcripts, ["completed before send failure"]);
			assert.ok(h.ends[0]);
			assertReleased(h);
		});
	}

	for (const failure of ["microphone", "worklet"] as const) {
		it(`synchronous ${failure} factory failure resolves finished and clears setup timeout`, async (t) => {
			const fail = () => { throw new Error("synthetic capture factory failure"); };
			const h = harness(t, failure === "microphone" ? { microphone: fail } : { worklet: fail });
			h.run.start();
			await h.run.finished;
			t.mock.timers.runAll();
			assert.equal(h.ends.length, 1);
			assert.match(h.ends[0]!, /could not start microphone capture/i);
			assert.equal(h.sockets.length, 0);
			assert.equal(h.stream.track.stops, failure === "microphone" ? 0 : 1);
		});
	}

	it("synchronous graph failure still stops a microphone granted later", async (t) => {
		const mic = deferred<MediaStream>();
		const h = harness(t, {
			microphone: () => mic.promise,
			audioGraph: () => { throw new Error("synthetic graph failure"); },
		});
		h.run.start();
		await h.run.finished;
		mic.resolve(h.stream as unknown as MediaStream);
		await settle();
		t.mock.timers.runAll();
		assert.equal(h.stream.track.stops, 1);
		assert.equal(h.sockets.length, 0);
		assert.equal(h.ends.length, 1);
		assert.match(h.ends[0]!, /could not start microphone capture/i);
	});

	for (const failure of ["source", "connect", "socket", "stop-message"] as const) {
		it(`cleans resources after synchronous ${failure} failure`, async (t) => {
			const h = harness(t, failure === "socket" ? { socket: () => { throw new Error("synthetic socket failure"); } } : {});
			if (failure === "source") h.ctx.createMediaStreamSource = () => { throw new Error("synthetic source failure"); };
			if (failure === "connect") h.worklet.connect = () => { throw new Error("synthetic connection failure"); };
			if (failure === "stop-message") h.worklet.port.postMessage = () => { throw new Error("synthetic port failure"); };
			h.run.start();
			await settle();
			if (failure === "stop-message") {
				assert.ok(h.sockets[0]);
				h.sockets[0].open(); h.run.stop();
			}
			await h.run.finished;
			t.mock.timers.runAll();
			assert.equal(h.ends.length, 1);
			assert.ok(h.ends[0]);
			assert.equal(h.stream.track.stops, 1);
			assert.equal(h.worklet.port.onmessage, null);
			assert.equal(h.worklet.port.closes, 1);
			assert.equal(getEventListeners(h.worklet, "processorerror").length, 0);
			assert.equal(getEventListeners(h.ctx, "statechange").length, 0);
			assert.equal(getEventListeners(h.stream.track, "ended").length, 0);
		});
	}

	for (const stage of ["setup", "drain", "final"] as const) {
		it(`actively clears the pending ${stage} timer on cancel`, async (t) => {
			const h = harness(t);
			const clear = t.mock.method(globalThis, "clearTimeout");
			const ws = await h.connecting();
			if (stage !== "setup") {
				ws.open();
				ws.result("discarded");
				h.run.stop();
				if (stage === "final") h.ack();
			}
			const before = clear.mock.callCount();
			h.run.cancel();
			assert.ok(clear.mock.callCount() > before, `cancel actively clears the remaining ${stage} timer`);
			t.mock.timers.runAll();
			assert.deepEqual(h.ends, [null]);
			assertReleased(h);
		});
	}

	it("handles synchronous server completion during CloseStream without creating a late final timer", async (t) => {
		const h = harness(t);
		const scheduled = t.mock.method(globalThis, "setTimeout");
		const ws = await h.recording();
		ws.result("synchronous final");
		ws.onSend = (data) => { if (data === closeStream) ws.serverClose(); };
		h.run.stop();
		const before = scheduled.mock.callCount();
		h.ack();
		await h.run.finished;
		assert.equal(scheduled.mock.callCount(), before, "no timer may be added after completion");
		assert.deepEqual(h.transcripts, ["synchronous final"]);
		assert.deepEqual(h.ends, [null]);
		assertReleased(h);
	});
});
