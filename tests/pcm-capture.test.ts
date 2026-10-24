import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";

type CaptureMessage =
	| { type: "level"; rms: number }
	| { type: "audio"; buffer: Int16Array }
	| { type: "stopped"; requestId: number };

type Processor = {
	port: { onmessage: ((event: { data: unknown }) => void) | null };
	process(inputs: Float32Array[][]): boolean;
};

// Execute the shipped worklet, not a second implementation of its algorithm.
// structuredClone models MessagePort's transfer/detachment semantics. All
// inputs are synthetic; no browser, microphone, credentials, or network.
const source = readFileSync(new URL("../public/worklets/pcm-capture.js", import.meta.url), "utf8");

function capture() {
	const messages: CaptureMessage[] = [];
	const transferred: ArrayBuffer[] = [];
	let ProcessorClass: (new () => Processor) | undefined;
	runInNewContext(source, {
		AudioWorkletProcessor: class {
			port = {
				onmessage: null,
				postMessage(message: CaptureMessage, transfer: ArrayBuffer[] = []) {
					messages.push(structuredClone(message, { transfer }));
					transferred.push(...transfer);
				},
			};
		},
		registerProcessor(name: string, constructor: new () => Processor) {
			assert.equal(name, "pcm-capture");
			ProcessorClass = constructor;
		},
	});
	assert.ok(ProcessorClass);
	const processor = new ProcessorClass();
	return {
		processor,
		messages,
		transferred,
		feed: (samples: Float32Array) => processor.process([[samples]]),
		stop: (requestId: number) => processor.port.onmessage!({ data: { type: "stop", requestId } }),
	};
}

describe("pcm-capture worklet", () => {
	it("preserves 2048-sample PCM frames, clamping, transfers, and per-quantum RMS", () => {
		const h = capture();
		const pattern = [-2, -1, -0.5, 0, 0.5, 1, 2, 0];
		const quantum = Float32Array.from({ length: 128 }, (_, i) => pattern[i % pattern.length]!);
		for (let i = 0; i < 32; i++) assert.equal(h.feed(quantum), true);
		const levels = h.messages.filter((m) => m.type === "level");
		const frames = h.messages.filter((m) => m.type === "audio");
		assert.equal(levels.length, 32);
		assert.equal(frames.length, 2);
		for (const level of levels) assert.equal(level.rms, Math.sqrt(10.5 / 8));
		for (const { buffer } of frames) {
			assert.ok(buffer instanceof Int16Array);
			assert.equal(buffer.length, 2048);
			assert.equal(buffer.byteLength, 4096);
			const expected = [-32768, -32768, -16384, 0, 16383, 32767, 32767, 0];
			for (let i = 0; i < buffer.length; i++) assert.equal(buffer[i], expected[i % expected.length]);
			assert.deepEqual(Array.from(new Uint8Array(buffer.buffer, 0, 4)), [0, 128, 0, 128]);
		}
		assert.equal(h.transferred.length, 2);
		for (const buffer of h.transferred) assert.equal(buffer.byteLength, 0);
	});

	it("drains only the captured partial samples after full frames and before the stopped acknowledgment", () => {
		const h = capture();
		for (let i = 0; i < 17; i++) h.feed(new Float32Array(128).fill(0.5));
		assert.equal(h.messages.filter((m) => m.type === "audio").length, 1);
		h.stop(42);
		const nonLevels = h.messages.filter((m) => m.type !== "level");
		assert.deepEqual(nonLevels.map((m) => m.type), ["audio", "audio", "stopped"]);
		const full = nonLevels[0];
		const partial = nonLevels[1];
		assert.ok(full?.type === "audio");
		assert.ok(partial?.type === "audio");
		assert.equal(full.buffer.length, 2048);
		assert.equal(partial.buffer.length, 128);
		assert.equal(partial.buffer.byteLength, 256);
		assert.ok(partial.buffer.every((sample) => sample === 16383));
		assert.deepEqual(nonLevels[2], { type: "stopped", requestId: 42 });
		assert.equal(h.transferred[1]?.byteLength, 0);
	});

	it("acknowledges stop with no audio when no samples were captured", () => {
		const h = capture();
		assert.equal(h.processor.process([]), true);
		h.stop(1);
		assert.deepEqual(h.messages, [{ type: "stopped", requestId: 1 }]);
		assert.equal(h.transferred.length, 0);
	});

	it("does not append an empty partial frame at an exact full-frame boundary", () => {
		const h = capture();
		for (let i = 0; i < 16; i++) h.feed(new Float32Array(128));
		h.stop(2);
		const frames = h.messages.filter((m) => m.type === "audio");
		assert.equal(frames.length, 1);
		assert.equal(frames[0]?.buffer.length, 2048);
		assert.ok(frames[0]?.buffer.every((sample) => sample === 0));
		assert.deepEqual(h.messages.at(-1), { type: "stopped", requestId: 2 });
	});

	it("acknowledges repeated stop commands without emitting the partial audio twice", () => {
		const h = capture();
		h.feed(new Float32Array(128).fill(-0.5));
		h.stop(3);
		h.stop(3);
		h.stop(4);
		assert.equal(h.messages.filter((m) => m.type === "audio").length, 1);
		assert.deepEqual(h.messages.filter((m) => m.type === "stopped"), [
			{ type: "stopped", requestId: 3 },
			{ type: "stopped", requestId: 3 },
			{ type: "stopped", requestId: 4 },
		]);
	});

	it("never emits audio or levels from process after the stop acknowledgment", () => {
		const h = capture();
		h.feed(new Float32Array(128).fill(0.25));
		h.stop(5);
		const messageCount = h.messages.length;
		for (let i = 0; i < 32; i++) assert.equal(h.feed(new Float32Array(128).fill(1)), true);
		assert.equal(h.processor.process([]), true);
		assert.equal(h.messages.length, messageCount);
		assert.deepEqual(h.messages.at(-1), { type: "stopped", requestId: 5 });
	});
});
