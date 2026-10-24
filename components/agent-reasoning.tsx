"use client";

import { useState } from "react";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { BrailleSpinner } from "@/components/braille-spinner";
import type { LhViewMessage, LhViewPart } from "@/src/core";

/** Owned above message fragments: persisted IDs replace live IDs at settle,
 * but the learner's disclosure choices must survive those fragment remounts. */
export function useAgentReasoningDisclosures(chatId: string) {
	const [openById, setOpenById] = useState<Record<string, boolean>>({});
	return (part: LhViewPart) => {
		const key = `${chatId}:${part.disclosureId ?? part.id}`;
		return {
			open: openById[key] ?? false,
			onOpenChange: (open: boolean) => setOpenById((previous) => ({ ...previous, [key]: open })),
		};
	};
}

/** Readable provider reasoning only; opaque/empty blocks never get a toggle. */
export function AgentReasoning({ part, open, onOpenChange }: {
	part: LhViewPart;
	open?: boolean;
	onOpenChange?: (open: boolean) => void;
}) {
	if (!part.text?.trim()) return null;
	return (
		<Reasoning isStreaming={part.state === "streaming"} open={open} onOpenChange={onOpenChange} className="mb-2">
			<ReasoningTrigger />
			<ReasoningContent>{part.text}</ReasoningContent>
		</Reasoning>
	);
}

/** Working without readable content is a status, not an empty disclosure. */
export function AgentWorking() {
	return (
		<span className="flex items-center gap-2 font-ui text-xs font-medium uppercase tracking-wide text-muted-foreground">
			<BrailleSpinner label="Thinking" />
			<Shimmer duration={1}>THINKING…</Shimmer>
		</span>
	);
}

/** Suppress the optimistic placeholder during projection/status handoffs. */
export function hasAgentThinkingIndicator(messages: readonly LhViewMessage[]): boolean {
	return messages.some((message) => message.role === "assistant" && message.parts.some((part) =>
		part.state === "streaming" && (
			part.type === "data-agent-working" ||
			(part.type === "reasoning" && Boolean(part.text?.trim()))
		),
	));
}
