import assert from "node:assert/strict";
import test from "node:test";
import { PRICES, callCost, turnCost, sessionCost, jobCost, sumSteps, contextWindow } from "../src/core/prices.ts";
import { graphCostSummary } from "../src/core/cost-summary.ts";
import type { CallUsage, ExtractionRunUsage, TurnUsage } from "../src/core/contracts.ts";

const COPILOT = "github-copilot:claude-sonnet-4.6";
const API = "openrouter:z-ai/glm-5.3-flash";
const usage: CallUsage = {
	inputTokens: 10_000,
	outputTokens: 1000,
	cacheReadTokens: 2000,
	cacheWriteTokens: 500,
	reasoningTokens: 100,
};
const turn = (model: string, steps = [usage]): TurnUsage => ({
	id: model, messageId: model, at: "2026-10-23T00:00:00Z", model, steps,
});
const run = (extractor: string, auditor: string, steps = [usage]): ExtractionRunUsage => ({
	startedAt: 1, at: "2026-10-23T00:00:00Z", durationMs: 100,
	stages: { extractor: { model: extractor, steps }, auditor: { model: auditor, steps } },
});

test("Copilot catalog prices remain generated but every Copilot model's dollars are unavailable", () => {
	const models = Object.keys(PRICES).filter((model) => model.startsWith("github-copilot:"));
	assert.ok(models.length > 0);
	for (const model of [...models, "github-copilot:future-model"]) {
		assert.equal(callCost(usage, model), null, model);
		assert.equal(callCost({ inputTokens: 0, outputTokens: 0 }, model), null);
		assert.equal(callCost({}, model), null);
	}
	assert.ok(callCost(usage, API)! > 0, "API prices still work");
	assert.equal(callCost(usage, "missing:model"), null);
});

test("Copilot turns, empty turns, and jobs are unpriced without losing token counts", () => {
	const snapshot = structuredClone(usage);
	assert.equal(turnCost(turn(COPILOT)), null);
	assert.equal(turnCost(turn(COPILOT, [])), null);
	assert.equal(jobCost({ usage: { ...usage, model: COPILOT, steps: 1 } }), null);
	assert.deepEqual(sumSteps([usage]), usage);
	assert.deepEqual(contextWindow({ turns: [turn(COPILOT)] }, new Map([[COPILOT, 200_000]])), {
		model: COPILOT, usedTokens: 13_500, limit: 200_000,
	});
	assert.deepEqual(usage, snapshot, "pricing must never mutate stored usage");
});

test("Copilot-only and mixed sessions retain unpriced counts alongside API subtotals", () => {
	assert.deepEqual(sessionCost({ turns: [turn(COPILOT)] }), { cost: 0, unpriced: 1 });
	assert.deepEqual(sessionCost({ turns: [turn(API), turn(COPILOT)] }), {
		cost: callCost(usage, API), unpriced: 1,
	});
});

test("Copilot graph stages retain tokens and mark mixed run subtotals incomplete", () => {
	const summary = graphCostSummary({ chats: [{ title: "mixed", extractions: [run(API, COPILOT)] }], sources: [] });
	assert.equal(summary.copilotUsage, true);
	assert.equal(summary.stages.extraction.dollars, callCost(usage, API));
	assert.equal(summary.stages.audit.unpricedRuns, 1);
	assert.deepEqual(summary.stages.audit.tokens, usage);
	assert.equal(summary.runs[0]!.copilotUsage, true);
	assert.equal(summary.runs[0]!.dollars, callCost(usage, API));
	assert.deepEqual(summary.runs[0]!.tokens, sumSteps([usage, usage]));
	assert.equal(summary.unpricedRuns, 0, "existing all-stages-unpriced count semantics stay unchanged");
});

test("Copilot-only graph runs, including empty stages, are unavailable instead of free", () => {
	for (const steps of [[usage], []]) {
		const summary = graphCostSummary({ chats: [], sources: [{ filePath: "notes.md", extractions: [run(COPILOT, COPILOT, steps)] }] });
		assert.equal(summary.copilotUsage, true);
		assert.equal(summary.stages.extraction.unpricedRuns, 1);
		assert.equal(summary.stages.audit.unpricedRuns, 1);
		assert.equal(summary.runs[0]!.dollars, null);
		assert.equal(summary.unpricedRuns, 1);
	}
});

test("Copilot graph completeness survives the recent-run cap; non-Copilot payloads stay unchanged", () => {
	const summary = graphCostSummary({
		chats: [{ title: "history", extractions: [run(COPILOT, COPILOT), { ...run(API, API), startedAt: 2 }] }],
		sources: [], recentCap: 1,
	});
	assert.equal(summary.copilotUsage, true);
	assert.equal(summary.runs.length, 1);
	assert.equal(summary.runs[0]!.copilotUsage, undefined);
	const apiOnly = graphCostSummary({ chats: [{ title: "API", extractions: [run(API, API)] }], sources: [] });
	assert.equal(apiOnly.copilotUsage, undefined);
	assert.equal(apiOnly.runs[0]!.copilotUsage, undefined);
});
