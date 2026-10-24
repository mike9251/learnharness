import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { AgentReasoning, AgentWorking, hasAgentThinkingIndicator, useAgentReasoningDisclosures } from "../components/agent-reasoning.tsx";
import type { LhViewMessage, LhViewPart } from "../src/core/view.ts";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window, document: dom.document, Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement, CustomEvent: dom.window.CustomEvent,
	IS_REACT_ACT_ENVIRONMENT: true,
	getComputedStyle: () => ({ animationName: "none", display: "block" }),
	requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 16),
	cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
});

let root: Root | null = null;
let host: HTMLDivElement;
beforeEach(() => { mock.timers.enable({ apis: ["setTimeout"] }); });
afterEach(async () => {
	await act(async () => { root?.unmount(); });
	root = null;
	host?.remove();
	mock.timers.reset();
});

async function render(ui: React.ReactNode) {
	if (!root) {
		host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
	}
	await act(async () => { root!.render(ui); });
}
async function toggle() {
	const button = host.querySelector("button");
	assert.ok(button);
	await act(async () => { button.dispatchEvent(new dom.window.Event("click", { bubbles: true })); });
}
function reasoning(text: string, state = "done", id = "step-1-reasoning"): LhViewPart {
	return { type: "reasoning", id, text, state };
}
const working: LhViewPart = { type: "data-agent-working", id: "step-2-working", state: "streaming" };
function messages(parts: LhViewPart[]): LhViewMessage[] {
	return [{ id: "assistant-1", role: "assistant", parts }];
}

// Exercise the same part components, stable keys and placeholder guard as chat.
function Transcript({ parts, pending = false }: { parts: LhViewPart[]; pending?: boolean }) {
	return <>
		{parts.map((part) => part.type === "reasoning"
			? <AgentReasoning key={part.id} part={part} />
			: part.type === "data-agent-working" ? <AgentWorking key={part.id} /> : null)}
		{pending && !hasAgentThinkingIndicator(messages(parts)) && <AgentWorking />}
	</>;
}

function KeyedTranscript({ chatId, messages }: { chatId: string; messages: LhViewMessage[] }) {
	const disclosureProps = useAgentReasoningDisclosures(chatId);
	return <>{messages.map((message) => <React.Fragment key={message.id}>
		{message.parts.map((part) => <AgentReasoning key={part.id} part={part} {...disclosureProps(part)} />)}
	</React.Fragment>)}</>;
}

describe("agent thinking disclosure", () => {
	it("preserves only the opened disclosure across persisted message/part ID replacement", async () => {
		const live = [
			{ ...reasoning("", "done", "c_1-reasoning-0"), disclosureId: "assistant-0-thinking-0" },
			{ ...reasoning("Opened thought", "streaming", "c_1-reasoning-1"), disclosureId: "assistant-0-thinking-1" },
			{ ...reasoning("Other thought", "done", "c_2-reasoning-0"), disclosureId: "assistant-1-thinking-0" },
		];
		await render(<KeyedTranscript chatId="chat-1" messages={[{ ...messages(live)[0]!, id: "c_1" }]} />);
		await toggle();
		assert.deepEqual([...host.querySelectorAll("button")].map((button) => button.getAttribute("aria-expanded")), ["true", "false"]);
		const liveButton = host.querySelector("button");

		const saved = live.map((part, index) => ({ ...part, id: `saved-part-${index}`, state: "done" }));
		await render(<KeyedTranscript chatId="chat-1" messages={[{ ...messages(saved)[0]!, id: "saved-message-1" }]} />);
		await act(async () => { mock.timers.tick(2000); });
		assert.notEqual(host.querySelector("button"), liveButton, "the keyed message really remounted");
		assert.deepEqual([...host.querySelectorAll("button")].map((button) => button.getAttribute("aria-expanded")), ["true", "false"]);
		assert.match(host.textContent ?? "", /Opened thought/);

		// A previously blank earlier block gaining content must not inherit
		// the opened block's state by rendered position.
		const late = saved.map((part, index) => index === 0 ? { ...part, text: "Late thought" } : part);
		await render(<KeyedTranscript chatId="chat-1" messages={messages(late)} />);
		assert.deepEqual([...host.querySelectorAll("button")].map((button) => button.getAttribute("aria-expanded")), ["false", "true", "false"]);

		// The same provider ordinals in another chat start closed.
		await render(<KeyedTranscript chatId="chat-2" messages={messages(late)} />);
		assert.deepEqual([...host.querySelectorAll("button")].map((button) => button.getAttribute("aria-expanded")), ["false", "false", "false"]);
	});

	it("starts collapsed, streams into an explicitly opened panel, and stays open after completion", async () => {
		await render(<AgentReasoning part={reasoning("First thought", "streaming")} />);
		assert.equal(host.querySelector("button")?.getAttribute("aria-expanded"), "false");
		assert.equal(host.querySelectorAll('[data-testid="braille-spinner"]').length, 1);
		await toggle();
		assert.equal(host.querySelector("button")?.getAttribute("aria-expanded"), "true");
		assert.match(host.textContent ?? "", /First thought/);

		await render(<AgentReasoning part={reasoning("First thought, then more reasoning", "streaming")} />);
		assert.match(host.textContent ?? "", /First thought, then more reasoning/);
		assert.equal(host.querySelector("button")?.getAttribute("aria-expanded"), "true");

		await render(<AgentReasoning part={reasoning("First thought, then more reasoning")} />);
		await act(async () => { mock.timers.tick(2000); });
		assert.equal(host.querySelector("button")?.getAttribute("aria-expanded"), "true");
		assert.match(host.textContent ?? "", /AGENT’S THINKING/);
		assert.equal(host.querySelectorAll('[data-testid="braille-spinner"]').length, 0);
		await toggle();
		assert.equal(host.querySelector("button")?.getAttribute("aria-expanded"), "false");
	});

	it("allows an explicit collapse while streaming without reopening on later text", async () => {
		await render(<AgentReasoning part={reasoning("First", "streaming")} />);
		await toggle();
		await toggle();
		await render(<AgentReasoning part={reasoning("First and second", "streaming")} />);
		assert.equal(host.querySelector("button")?.getAttribute("aria-expanded"), "false");
	});

	it("does not render empty historical or streaming panels", () => {
		const html = renderToStaticMarkup(<Transcript parts={[
			reasoning("", "done", "old-1"), reasoning(" \n\t", "done", "old-2"),
			{ type: "reasoning", id: "old-3" }, reasoning("", "streaming", "active"),
		]} />);
		assert.equal(html, "");
	});

	it("renders opaque-only waiting as a non-expandable status with no content body", () => {
		const html = renderToStaticMarkup(<AgentWorking />);
		assert.match(html, /THINKING…/);
		assert.match(html, /role="status"/);
		assert.doesNotMatch(html, /<button|aria-expanded|data-slot="collapsible/);
	});

	it("keeps genuine steps separate and uses active state, not the last rendered position", async () => {
		const done = reasoning("Historical thought", "done", "previous-reasoning");
		const active = reasoning("Live thought", "streaming", "current-reasoning");
		await render(<Transcript parts={[done, active, { type: "text", text: "Answer" }]} />);
		const buttons = [...host.querySelectorAll("button")];
		assert.equal(buttons.length, 2);
		assert.ok(buttons[0]);
		assert.ok(buttons[1]);
		assert.equal(buttons[0].textContent, "AGENT’S THINKING");
		assert.match(buttons[1].textContent ?? "", /Thinking/);
		assert.equal(buttons[0].querySelectorAll('[role="status"]').length, 0);
		assert.equal(buttons[1].querySelectorAll('[role="status"]').length, 1);
		await act(async () => { buttons[1]!.dispatchEvent(new dom.window.Event("click", { bubbles: true })); });
		// A preceding blank part disappearing must not remount the open live panel.
		await render(<Transcript parts={[reasoning("", "done", "empty"), done, active]} />);
		assert.equal(host.querySelectorAll("button")[1]?.getAttribute("aria-expanded"), "true");
		await render(<Transcript parts={[done, { ...active, state: "done" }]} />);
		assert.equal(host.querySelectorAll("button")[1]?.getAttribute("aria-expanded"), "true");
	});

	it("does not duplicate projected working or active reasoning during pending-status overlaps", () => {
		for (const active of [working, reasoning("Readable", "streaming")]) {
			const html = renderToStaticMarkup(<Transcript pending parts={[reasoning("Previous", "done", "old"), active]} />);
			assert.equal((html.match(/data-testid="braille-spinner"/g) ?? []).length, 1);
		}
		assert.equal(hasAgentThinkingIndicator(messages([reasoning("Completed")])), false);
		assert.equal(hasAgentThinkingIndicator(messages([reasoning(" \n", "streaming")])), false);
		const fallback = renderToStaticMarkup(<Transcript pending parts={[reasoning("Completed")]} />);
		assert.equal((fallback.match(/data-testid="braille-spinner"/g) ?? []).length, 1);
	});
});
