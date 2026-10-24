import React from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { StatsBar } from "../components/stats-bar.tsx";
import { ActivitySection, toBlobs, type ActivityFeed } from "../components/activity-dock.tsx";
import { GraphCostControl, GraphCostPanel } from "../components/graph-view.tsx";
import { ModelMenuList } from "../components/settings/model-menu.tsx";
import { graphCostSummary } from "../src/core/cost-summary.ts";
import type { CallUsage, ExtractionRunUsage, ModelCatalogEntry, TurnUsage } from "../src/core/contracts.ts";

const COPILOT = "github-copilot:claude-sonnet-4.6";
const API = "openrouter:z-ai/glm-5.3-flash";
const usage: CallUsage = { inputTokens: 10_000, outputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
const turn = (model: string): TurnUsage => ({ id: model, messageId: model, at: "2026-10-23T00:00:00Z", model, steps: [usage] });
const job = (model: string): ActivityFeed["jobs"][number] => ({
	id: model, kind: "research", chatId: "chat", toolCallId: model, status: "running", title: "Research", activity: "Researching…",
	createdAt: "2026-10-23T00:00:00Z", updatedAt: "2026-10-23T00:00:00Z", contextLimit: 200_000,
	usage: { ...usage, model, steps: 1, lastStep: usage },
});
const costs = (extractor: string, auditor: string) => {
	const run: ExtractionRunUsage = {
		startedAt: 1, at: "2026-10-23T00:00:00Z", durationMs: 100,
		stages: { extractor: { model: extractor, steps: [usage] }, auditor: { model: auditor, steps: [usage] } },
	};
	return graphCostSummary({ chats: [{ title: "Lesson", extractions: [run] }], sources: [] });
};

test("Copilot stats show unavailable dollars and the existing token footprint", () => {
	const html = renderToStaticMarkup(<StatsBar turns={[turn(COPILOT)]} />);
	assert.match(html, /data-testid="stats-cost"[^>]*>—</);
	assert.match(html, /GitHub tracks subscription usage/);
	assert.match(html, /data-testid="stats-context">11k</);
	const mixed = renderToStaticMarkup(<StatsBar turns={[turn(API), turn(COPILOT)]} />);
	assert.match(mixed, /data-testid="stats-cost"[^>]*>\$0\.0020 \+ unpriced</);
});

test("Copilot activity jobs and mixed running totals never imply free or complete cost", () => {
	const feed: ActivityFeed = { jobs: [job(COPILOT)], extractions: [] };
	const blob = toBlobs(feed)[0]!;
	assert.equal(blob.cost, null);
	assert.deepEqual(blob.context, { used: 11_000, limit: 200_000 });
	const html = renderToStaticMarkup(<ActivitySection feed={feed} />);
	assert.match(html, /data-testid="activity-total-cost"[^>]*>—</);
	assert.match(html, /data-testid="activity-blob-cost"[^>]*>—</);
	assert.match(html, /GitHub tracks subscription usage/);
	const mixed = renderToStaticMarkup(<ActivitySection feed={{ jobs: [job(API), job(COPILOT)], extractions: [] }} />);
	assert.match(mixed, /data-testid="activity-total-cost"[^>]*>\$0\.0020 \+ unpriced</);
});

test("Copilot graph-only headlines, stages and recent runs show unavailable dollars, preserving tokens", () => {
	const summary = costs(COPILOT, COPILOT);
	for (const view of [<GraphCostControl costs={summary} />, <GraphCostPanel costs={summary} />]) {
		const html = renderToStaticMarkup(view);
		assert.ok(!html.includes("$0.00"), "unpriced subscription usage cannot appear free");
		assert.match(html, /—/);
		assert.match(html, /GitHub tracks subscription usage/);
	}
	const panel = renderToStaticMarkup(<GraphCostPanel costs={summary} />);
	assert.match(panel, /10\.0k in \/ 1\.0k out/);
});

test("mixed graph headlines and recent runs visibly qualify API subtotals", () => {
	const summary = costs(API, COPILOT);
	const control = renderToStaticMarkup(<GraphCostControl costs={summary} />);
	assert.match(control, /\$0\.00 \+ unpriced/);
	const panel = renderToStaticMarkup(<GraphCostPanel costs={summary} />);
	assert.match(panel, /1 unpriced/);
	assert.match(panel, /\$0\.002 \+ unpriced/);
	assert.match(panel, /GitHub tracks subscription usage/);
});

test("mixed genuinely-free API and Copilot graph usage keeps the free subtotal visibly incomplete", () => {
	const summary = costs("openrouter:openrouter/free", COPILOT);
	// Use a generated free route with confirmed zero pricing (the free-model suite pins it too).
	assert.equal(summary.stages.extraction.dollars, 0);
	assert.equal(summary.stages.extraction.unpricedRuns, 0);
	const html = renderToStaticMarkup(<GraphCostControl costs={summary} />);
	assert.match(html, /\$0\.00 \+ unpriced/);
});

test("model menu hides Copilot API-equivalent catalog prices but keeps API rates and context", () => {
	const model = (provider: string): ModelCatalogEntry => ({
		provider, id: "claude-sonnet-4.6", name: "Sonnet", reasoning: true, supportedLevels: ["off", "low", "medium", "high"],
		input: ["text"], contextWindow: 200_000, maxTokens: 16_000,
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	});
	const copilot = renderToStaticMarkup(<ModelMenuList models={[model("github-copilot")]} effectiveId={undefined} onPick={() => {}} />);
	assert.match(copilot, /GitHub tracks subscription usage/);
	assert.match(copilot, />—</);
	assert.match(copilot, /200k/);
	assert.ok(!copilot.includes("$3.00/$15.00"));
	const api = renderToStaticMarkup(<ModelMenuList models={[model("anthropic")]} effectiveId={undefined} onPick={() => {}} />);
	assert.match(api, /\$3\.00\/\$15\.00/);
});
