import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fauxAssistantMessage, type AssistantMessage } from "@earendil-works/pi-ai";
import { projectView, type LiveTurnState } from "../src/core/view.ts";
import type { LhMessage } from "../src/core/native-messages.ts";
import { SessionModel } from "../components/session-core.ts";

function message(id: string, content: AssistantMessage["content"]): LhMessage {
	return { ...fauxAssistantMessage(content), id, provider: "github-copilot", model: "gpt-6-astra" } as LhMessage;
}
function live(activeMessageId: string | null, ...ids: string[]): LiveTurnState {
	return { executions: new Map(), inFlight: true, streamingIds: new Set(ids), activeMessageId };
}
const parts = (messages: LhMessage[], state?: LiveTurnState) => projectView(messages, state).flatMap((m) => m.parts).filter((p) => p.type !== "step-start");
const opaque = () => ({ type: "thinking" as const, thinking: "", thinkingSignature: "fake-opaque-must-not-be-visible" });

describe("agent reasoning projection", () => {
	it("hides empty, whitespace-only, and redacted blocks without modifying provider context", () => {
		const source = message("a", [opaque(), { type: "thinking", thinking: "\n  " }, { type: "thinking", thinking: "[Reasoning redacted]", redacted: true, thinkingSignature: "private" }, { type: "text", text: "Answer." }]);
		const saved = JSON.stringify(source);
		assert.deepEqual(parts([source]).map((p) => [p.type, p.text]), [["text", "Answer."]]);
		assert.equal(JSON.stringify(source), saved);
		assert.doesNotMatch(JSON.stringify(projectView([source])), /fake-opaque|private|Reasoning redacted/);
	});
	it("multiple opaque items produce one current working marker, never empty panels", () => {
		const old = message("old", [opaque()]);
		const current = message("current", [opaque(), opaque(), { type: "thinking", thinking: "\n" }]);
		const visible = parts([old, current], live("current", "old", "current"));
		assert.deepEqual(visible, [{ type: "data-agent-working", id: "current-working", state: "streaming" }]);
		assert.deepEqual(parts([old, current], live(null, "old", "current")), []);
		assert.deepEqual(parts([old, current]), [], "reloaded history has no fake reasoning panels");
	});
	it("replaces the working marker with provider text and keeps native block identities", () => {
		const source = message("a", [opaque(), { type: "thinking", thinking: "Check the " }]);
		const state = live("a", "a");
		assert.deepEqual(parts([source], state), [{ type: "reasoning", id: "a-r1", disclosureId: "reasoning-0-1", text: "Check the ", state: "streaming" }]);
		const next = message("a", [opaque(), { type: "thinking", thinking: "Check the units first." }]);
		assert.deepEqual(parts([next], state), [{ type: "reasoning", id: "a-r1", disclosureId: "reasoning-0-1", text: "Check the units first.", state: "streaming" }]);
		// An earlier empty block acquiring text must not steal r1's open state.
		const filled = message("a", [{ type: "thinking", thinking: "A summary." }, { type: "thinking", thinking: "Check the units first." }]);
		assert.deepEqual(parts([filled], state).map((p) => p.id), ["a-r0", "a-r1"]);
	});
	it("tracks the native active block, not its reordered screen position", () => {
		const source = message("a", [{ type: "text", text: "Answer." }, { type: "thinking", thinking: "A trailing check." }]);
		const visible = parts([source], live("a", "a"));
		assert.equal(visible[0]?.type, "reasoning", "reasoning still appears above its answer");
		assert.equal(visible[0]?.state, "streaming", "first on screen can still be the active native block");
		assert.equal(parts([source], live(null, "a"))[0]?.state, "done");
		const textStarted = message("a", [{ type: "thinking", thinking: "Check." }, { type: "text", text: "Answer." }]);
		assert.equal(parts([textStarted], live("a", "a"))[0]?.state, "done", "reasoning stops spinning when answer text begins");
	});
	it("preserves separate genuine steps while only the current step is active", () => {
		const first = message("a", [{ type: "thinking", thinking: "First step." }]);
		const second = message("b", [{ type: "thinking", thinking: "Second step." }]);
		assert.deepEqual(parts([first, second], live("b", "a", "b")).map((p) => [p.id, p.state]), [["a-r0", "done"], ["b-r0", "streaming"]]);
	});
	it("keeps disclosure identity when saved IDs replace live IDs, including hidden opaque messages", () => {
		const source = [message("local-1", [opaque()]), message("local-2", [opaque(), { type: "thinking", thinking: "Readable summary." }])];
		const before = parts(source, live("local-2", "local-1", "local-2")).find((p) => p.type === "reasoning")!;
		const saved = source.map((m, i) => ({ ...m, id: `persisted-${i}` }));
		const after = parts(saved).find((p) => p.type === "reasoning")!;
		assert.notEqual(before.id, after.id);
		assert.equal(before.disclosureId, after.disclosureId);
		assert.equal(after.disclosureId, "reasoning-1-1");
	});
	it("uses an activity marker for a silent message start, including empty text starts", () => {
		for (const content of [[], [{ type: "text" as const, text: "" }]]) {
			const visible = parts([message("a", content)], live("a", "a"));
			assert.equal(visible.filter((p) => p.type === "data-agent-working").length, 1);
			assert.equal(visible.filter((p) => p.type === "reasoning").length, 0);
		}
	});
});

it("message_end clears activity before subscribers render, even while the next tool step is pending", async () => {
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	const stream = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
	const seen: ReturnType<SessionModel["getState"]>[] = [];
	const session = new SessionModel({ chatId: "synthetic", initialMessages: [], onChange: () => seen.push(session.getState()), fetch: async () => { throw new Error("No network in this test"); } });
	const consuming = session.consumeStream(new Response(stream));
	const send = async (type: string, m: LhMessage) => {
		controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type, message: m })}\n\n`));
		await new Promise<void>((resolve) => setImmediate(resolve));
	};
	try {
		await send("message_start", message("a", [opaque(), opaque()]));
		assert.equal(session.getState().messages.flatMap((m) => m.parts).filter((p) => p.type === "data-agent-working").length, 1);
		seen.length = 0;
		await send("message_end", message("a", [opaque(), opaque()]));
		assert.ok(seen.length > 0);
		for (const state of seen) assert.equal(state.messages.flatMap((m) => m.parts).some((p) => p.type === "data-agent-working"), false);
		await send("message_start", message("b", [{ type: "thinking", thinking: "Readable summary" }]));
		assert.equal(session.getState().messages.flatMap((m) => m.parts).filter((p) => p.type === "reasoning").length, 1);
		seen.length = 0;
		await send("message_end", message("b", [{ type: "thinking", thinking: "Readable summary" }]));
		for (const state of seen) assert.equal(state.messages.flatMap((m) => m.parts).find((p) => p.type === "reasoning")?.state, "done");
	} finally {
		controller.close();
		await consuming;
	}
});
