/**
 * Offline end-to-end reasoning transport regression: real Copilot catalog +
 * Responses SDK/parser → native Agent → runPiTurn's slim/coalesced SSE →
 * SessionModel/projectView. Only fetch is mocked; no faux provider, auth,
 * account discovery, network, or learner data is involved.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import { createModels, type AssistantMessage, type ThinkingContent } from "@earendil-works/pi-ai";
import { githubCopilotProvider } from "@earendil-works/pi-ai/providers/github-copilot";
import type { LhMessage } from "../src/core/native-messages.ts";

// runPiTurn imports the server composition through jobs. Isolate BEFORE the
// first runtime app import, including auth reads performed during composition.
const root = mkdtempSync(path.join(tmpdir(), "lh-copilot-reasoning-"));
process.env.LH_AUTH_FILE = path.join(root, "auth.json");
process.env.LH_DATA_DIR = path.join(root, "data");
const { runPiTurn } = await import("../src/server/pi/ui-stream.ts");
const { SessionModel } = await import("../components/session-core.ts");
const { projectView } = await import("../src/core/view.ts");
after(() => rmSync(root, { recursive: true, force: true }));

type Session = InstanceType<typeof SessionModel>;
const KEY = "fake-copilot-reasoning-transport-key";
const FIRST = "Compare the two quantities.";
const SECOND = "Check the units before answering.";
const FINAL = "The answer is 42.";

function reasoningItem(id: string, text = "", raw = false) {
	return {
		id, type: "reasoning", status: "completed",
		summary: raw || !text ? [] : [{ type: "summary_text", text }],
		...(raw && text ? { content: [{ type: "reasoning_text", text }] } : {}),
		encrypted_content: `opaque-test-payload-${id}`,
	};
}

function currentParts(session: Session) {
	return session.getState().messages.at(-1)?.parts ?? [];
}
function thoughts(session: Session) {
	return currentParts(session).filter((part) => part.type === "reasoning");
}
function working(session: Session) {
	return currentParts(session).filter((part) => part.type === "data-agent-working");
}
function currentNative(session: Session) {
	return session.getState().nativeMessages.at(-1) as AssistantMessage;
}

/** Event-driven checkpoint: don't release the next provider chunk until the
 * live session actually displays this one. A final-only implementation cannot
 * pass, because response.completed has not even been enqueued yet. */
function until(session: Session, predicate: () => boolean, label: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const previous = session.onChange;
		const timer = setTimeout(() => {
			session.onChange = previous;
			reject(new Error(`No live ${label}: ${JSON.stringify(session.getState())}`));
		}, 3000);
		const check = () => {
			previous?.();
			if (!predicate()) return;
			clearTimeout(timer);
			session.onChange = previous;
			resolve();
		};
		session.onChange = check;
		check();
	});
}

function assertNoEmptyPanels(session: Session) {
	for (const message of session.getState().messages) {
		for (const part of message.parts.filter((p) => p.type === "reasoning")) {
			assert.ok(part.text?.trim(), "every expandable reasoning part has readable text");
		}
	}
	const historical = session.getState().messages.find((m) => m.id === "previous")!;
	assert.equal(historical.parts.some((p) => p.type === "data-agent-working"), false,
		"a completed earlier message never receives the current working marker");
	assert.ok(historical.parts.filter((p) => p.type === "reasoning").every((p) => p.state === "done"));
}

describe("Copilot GPT-6 Astra reasoning transport", { concurrency: false }, () => {
	for (const raw of [false, true]) {
		const deltaType = raw ? "response.reasoning_text.delta" : "response.reasoning_summary_text.delta";
		it(`${deltaType}: live text, opaque preservation, multiple blocks, and compacted reattach`, { timeout: 12000 }, async () => {
			const realFetch = globalThis.fetch;
			const models = createModels({ authContext: { env: async () => undefined, fileExists: async () => false } });
			models.setProvider(githubCopilotProvider());
			const model = models.getModel("github-copilot", "gpt-6-astra");
			assert.ok(model, "exercise the installed real Astra model, not a fabricated model");
			assert.equal(model.api, "openai-responses");
			let provider!: ReadableStreamDefaultController<Uint8Array>;
			const body = new ReadableStream<Uint8Array>({ start(controller) { provider = controller; } });
			let sequence = 0;
			const emit = (type: string, fields: Record<string, unknown>) => {
				const event = { type, sequence_number: sequence++, ...fields };
				provider.enqueue(new TextEncoder().encode(`event: ${type}\ndata: ${JSON.stringify(event)}\n\n`));
			};
			const requests: Record<string, unknown>[] = [];
			globalThis.fetch = async (input, init) => {
				const request = new Request(input, init);
				assert.equal(request.url, "https://api.individual.githubcopilot.com/responses", "CLOSED fetch: only mocked Copilot inference is allowed");
				assert.equal(request.method, "POST");
				assert.equal(request.headers.get("authorization"), `Bearer ${KEY}`);
				requests.push(await request.json());
				return new Response(body, { headers: { "content-type": "text/event-stream" } });
			};
			const previous: LhMessage = {
				id: "previous", role: "assistant", api: "openai-responses", provider: model.provider, model: model.id,
				content: [
					{ type: "thinking", thinking: "An earlier completed thought." },
					{ type: "thinking", thinking: "", thinkingSignature: JSON.stringify(reasoningItem("rs_previous")) },
					{ type: "text", text: "Earlier answer." },
				],
				stopReason: "stop", timestamp: 1,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			};
			const initial: LhMessage[] = [previous, { id: "question", role: "user", content: "Explain the answer.", timestamp: 2 }];
			const providerEvents: string[] = [];
			const agent = new Agent({
				initialState: { model, messages: initial, thinkingLevel: "medium", systemPrompt: "Offline transport test.", tools: [] },
				getApiKey: () => KEY,
				streamFn: (m, context, options) => models.streamSimple(m, context, { ...options, maxRetries: 0 }),
				onProviderStreamEvent: (event) => { providerEvents.push((event as { type: string }).type); },
			});
			let settled: AgentMessage[] | undefined;
			const handle = runPiTurn({ agent, updateFlushMs: 1, onFinish: (messages) => { settled = messages; } });
			const session = new SessionModel({ chatId: "offline", initialMessages: initial });
			const consuming = session.consumeStream(new Response(handle.subscribe()));
			const reattached = new SessionModel({
				chatId: "offline", initialMessages: initial,
				fetch: async (input) => {
					assert.equal(String(input), "/api/chats/offline/stream", "attach-first needs no record fetch");
					return new Response(handle.subscribe());
				},
			});
			let replay: Promise<void> | undefined;
			let closed = false;
			try {
				emit("response.created", { response: { id: "resp_offline", status: "in_progress" } });
				emit("response.output_item.added", { output_index: 0, item: { id: "rs_opaque", type: "reasoning", summary: [] } });
				await until(session, () => currentNative(session).role === "assistant" && currentNative(session).content.some((p) => p.type === "thinking"), "opaque reasoning start");
				assert.equal(working(session).length, 1);
				assert.deepEqual(thoughts(session), []);
				assertNoEmptyPanels(session);
				assert.equal(requests.length, 1);
				assert.equal(requests[0]!.model, "gpt-6-astra");
				assert.deepEqual(requests[0]!.reasoning, { effort: "medium", summary: "auto" }, "the provider already asks for readable summaries");
				assert.ok((requests[0]!.include as string[]).includes("reasoning.encrypted_content"));
				assert.ok((requests[0]!.input as Array<Record<string, unknown>>).some((item) => item.encrypted_content === "opaque-test-payload-rs_previous"), "native encrypted history remains usable on the provider wire");

				emit("response.output_item.done", { output_index: 0, item: reasoningItem("rs_opaque") });
				emit("response.output_item.added", { output_index: 1, item: { id: "rs_first", type: "reasoning", summary: [] } });
				emit(deltaType, { output_index: 1, item_id: "rs_first", summary_index: 0, content_index: 0, delta: "Compare " });
				await until(session, () => thoughts(session)[0]?.text === "Compare ", "first readable reasoning delta");
				assert.equal(settled === undefined, true, "readable reasoning arrives before provider completion");
				assert.equal(thoughts(session)[0]!.state, "streaming");
				assert.equal(working(session).length, 0);
				emit(deltaType, { output_index: 1, item_id: "rs_first", summary_index: 0, content_index: 0, delta: "the two quantities." });
				await until(session, () => thoughts(session)[0]?.text === FIRST, "second delta replaces the full partial");
				assert.equal(thoughts(session).length, 1, "chunks do not become duplicate panels");

				// Real reattach replays the server's compacted current snapshot, not
				// the old partials. It must show the same text without duplication.
				replay = reattached.resumeStream(false);
				await until(reattached, () => thoughts(reattached)[0]?.text === FIRST, "reattached readable snapshot");
				assert.equal(thoughts(reattached).length, 1);
				assert.equal(thoughts(reattached)[0]!.state, "streaming");
				assert.equal(working(reattached).length, 0);

				emit("response.output_item.done", { output_index: 1, item: reasoningItem("rs_first", FIRST, raw) });
				emit("response.output_item.added", { output_index: 2, item: { id: "rs_second", type: "reasoning", summary: [] } });
				await until(session, () => currentNative(session).content.length === 3, "next empty reasoning block");
				assert.deepEqual(thoughts(session).map((p) => [p.text, p.state]), [[FIRST, "done"]]);
				assert.equal(working(session).length, 1, "only the current empty reasoning phase gets a non-reasoning working part");
				assertNoEmptyPanels(session);
				emit(deltaType, { output_index: 2, item_id: "rs_second", summary_index: 0, content_index: 0, delta: SECOND });
				await until(session, () => thoughts(session)[1]?.text === SECOND, "second readable block");
				assert.deepEqual(thoughts(session).map((p) => [p.text, p.state]), [[FIRST, "done"], [SECOND, "streaming"]]);
				assert.equal(working(session).length, 0);
				emit("response.output_item.done", { output_index: 2, item: reasoningItem("rs_second", SECOND, raw) });
				emit("response.output_item.added", { output_index: 3, item: { id: "msg_final", type: "message", role: "assistant", content: [] } });
				emit("response.output_text.delta", { output_index: 3, item_id: "msg_final", content_index: 0, delta: FINAL });
				await until(session, () => currentParts(session).some((p) => p.type === "text" && p.text === FINAL), "answer text");
				assert.ok(thoughts(session).every((p) => p.state === "done"), "reasoning stops streaming when native text starts");
				assert.equal(working(session).length, 0);
				const finalItem = { id: "msg_final", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: FINAL, annotations: [] }] };
				emit("response.output_item.done", { output_index: 3, item: finalItem });
				emit("response.completed", { response: {
					id: "resp_offline", status: "completed",
					output: [reasoningItem("rs_opaque"), reasoningItem("rs_first", FIRST, raw), reasoningItem("rs_second", SECOND, raw), finalItem],
					usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 12 } },
				} });
				provider.close();
				closed = true;
				await Promise.all([consuming, replay, agent.waitForIdle()]);
				assert.ok(providerEvents.includes(deltaType), "real provider processed the exact reasoning event family");
				assert.equal(requests.length, 1, "reattach never restarts inference");
				assert.ok(settled);
				const final = settled.at(-1) as AssistantMessage;
				assert.equal(final.stopReason, "stop");
				assert.equal(final.provider, "github-copilot");
				assert.equal(final.model, "gpt-6-astra");
				const nativeThoughts = final.content.filter((p): p is ThinkingContent => p.type === "thinking");
				assert.deepEqual(nativeThoughts.map((p) => p.thinking), ["", FIRST, SECOND]);
				assert.deepEqual(JSON.parse(nativeThoughts[0]!.thinkingSignature!), reasoningItem("rs_opaque"), "encrypted-only item survives unchanged through the settle seam");
				for (const view of [session, reattached]) {
					assert.equal(view.status, "ready");
					assert.equal(view.getState().error, null);
					assert.equal(view.getState().nativeMessages.length, initial.length + 1, "one native message, not one per delta/replay");
					assert.deepEqual(thoughts(view).map((p) => [p.text, p.state]), [[FIRST, "done"], [SECOND, "done"]]);
					assert.equal(working(view).length, 0);
					assertNoEmptyPanels(view);
				}
				const persisted = settled.map((message, index) => ({ ...message, id: `persisted_${index}` })) as LhMessage[];
				const projected = projectView(persisted).at(-1)!.parts;
				assert.deepEqual(projected.map((p) => [p.type, p.text, p.state]), currentParts(session).map((p) => [p.type, p.text, p.state]),
					"idle record projection agrees with final live content/state (server stamps replace client ids)");
				session.setMessages(persisted);
				assert.deepEqual(currentParts(session), projected, "settle sync replaces local ids without duplicated panels");
				assert.deepEqual(currentNative(session).content, final.content, "settle sync retains opaque native blocks too");
			} finally {
				if (!closed) provider.close();
				handle.abort();
				await Promise.allSettled([consuming, ...(replay ? [replay] : []), agent.waitForIdle()]);
				globalThis.fetch = realFetch;
			}
		});
	}
});
