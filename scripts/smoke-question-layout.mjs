/**
 * Real-Chrome regression smoke for question/practice dock layout.
 * Run against an existing packaged build (never builds or contacts a model):
 *   node scripts/smoke-question-layout.mjs [--screenshots] [--timeout=60]
 * Screenshots, if requested, contain synthetic fixtures only and go to /tmp.
 * Fixtures follow contracts/chat.ts, tests/practice-record.test.ts and phases.ts.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import puppeteer from "puppeteer-core";
import { probeEnv } from "./smoke-demo-runtime.mjs";

const STANDALONE = path.resolve(import.meta.dirname, "../.next/standalone");
const SERVER = path.join(STANDALONE, "server.js");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const seconds = Number(process.argv.find((a) => a.startsWith("--timeout="))?.split("=")[1] ?? 60);
assert.ok(Number.isFinite(seconds) && seconds >= 15 && seconds <= 180, "--timeout must be 15..180 seconds");
const shots = process.argv.includes("--screenshots");
const log = (stage) => console.log(`[smoke-question-layout] ${stage}`);
const testid = (id) => `[data-testid="${id}"]`;
const SCROLLER = testid("session-scroll-viewport");
const AREA = "[data-dock-scroll-area]";
const SURFACE = "[data-dock-surface]";
const stamps = {
	api: "faux", provider: "test", model: "test-model", stopReason: "toolUse",
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
};
const assistant = (id, content) => ({ ...stamps, id, role: "assistant", timestamp: 1, content });
const call = (id, name, args) => assistant(`msg_${id}`, [{ type: "toolCall", id, name, arguments: args }]);
const result = (id, toolName) => ({ id: `result_${id}`, role: "toolResult", timestamp: 2,
	toolCallId: id, toolName, content: [{ type: "text", text: "Synthetic local fixture acknowledged." }], details: null, isError: false });
const statement = ["LAYOUT QUESTION START", ...Array.from({ length: 28 }, (_, i) =>
	`Paragraph ${i + 1}. Consider a row of paired counters. Explain why regrouping the pairs does not change the total. This deliberately long synthetic question must remain readable without moving the earlier conversation.`), "LAYOUT QUESTION END"].join("\n\n");
const cases = [
	{ id: "layout_teach_quiz", name: "teach quiz", field: "thinking-field", dock: "question-dock", bar: "question-dock-bar", quiz: true,
		messages: [call("probe_done", "probe_done", {}), result("probe_done", "probe_done"), call("quiz", "quiz", {
			type: "check", nodeId: "fixture-node", question: statement,
			options: [{ label: "The counters remain paired." }, { label: "Regrouping creates a counter." }, { label: "The total depends on order." }],
			correctAnswer: "The counters remain paired.", explanation: "Regrouping does not add or remove counters.",
		})] },
	{ id: "layout_practice", name: "practice problem", field: "practice-thinking-field", dock: "practice-dock", bar: "practice-dock-bar", kind: "practice",
		messages: [call("problem", "problem", { statement, mode: "recall", modelSolution: "Pair the counters." }), result("problem", "problem")] },
	{ id: "layout_free_text", name: "teach free-text", field: "answer-field", dock: "question-dock", bar: "question-dock-bar",
		messages: [call("probe_done", "probe_done", {}), result("probe_done", "probe_done"), call("explain", "explain", {
			type: "check", nodeId: "fixture-node", question: statement, correctAnswer: "Regrouping preserves the total.",
		})] },
];
function seed(home) {
	const dir = path.join(home, "data/chats");
	fs.mkdirSync(dir, { recursive: true });
	for (const fixture of cases) {
		const history = Array.from({ length: 18 }, (_, i) => [
			{ id: `history_user_${i}`, role: "user", timestamp: i * 2, content: `Earlier synthetic question ${i + 1}: how do pairs work?` },
			{ ...assistant(`history_assistant_${i}`, [{ type: "text", text: Array(3).fill(`Earlier explanation ${i + 1}: two counters form one pair. Moving a pair changes its position, not its size. This is generated test history, not a real conversation.`).join("\n\n") }]), stopReason: "stop" },
		]).flat();
		fs.writeFileSync(path.join(dir, `${fixture.id}.json`), JSON.stringify({ version: 1, id: fixture.id,
			title: `Smoke: ${fixture.name}`, createdAt: "2026-10-24T00:00:00.000Z", updatedAt: "2026-10-24T00:00:00.000Z",
			...(fixture.kind ? { kind: fixture.kind } : {}), messages: [...history, ...fixture.messages] }));
	}
	fs.writeFileSync(path.join(home, "auth.json"), "{}\n", { mode: 0o600 });
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
async function stop(child) {
	if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
	const exited = new Promise((resolve) => child.once("exit", resolve));
	child.kill("SIGTERM");
	let timer;
	try {
		await Promise.race([exited, new Promise((resolve) => { timer = setTimeout(resolve, 2000); })]);
		if (child.exitCode === null && child.signalCode === null) {
			child.kill("SIGKILL");
			await exited;
		}
	} finally { clearTimeout(timer); }
}

async function snapshot(page, fixture) {
	return page.evaluate(({ scroller, area, surface, field, dock }) => {
		const root = document.querySelector(dock);
		const q = root?.querySelector(area);
		const s = root?.matches(surface) ? root : root?.querySelector(surface) ?? root?.closest(surface);
		const t = document.querySelector(scroller);
		const textarea = document.querySelector(field + " textarea");
		const submit = root?.querySelector('button[type="submit"], [data-testid="practice-send"]');
		const rect = (el) => {
			if (!el) return null;
			const r = el.getBoundingClientRect();
			return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height };
		};
		return { surface: rect(s), question: rect(q), textarea: rect(textarea), submit: rect(submit), transcript: rect(t),
			transcriptTop: t?.scrollTop, transcriptMax: t ? t.scrollHeight - t.clientHeight : null,
			questionTop: q?.scrollTop, questionMax: q ? q.scrollHeight - q.clientHeight : null,
			surfaceTop: s?.scrollTop, surfaceMax: s ? s.scrollHeight - s.clientHeight : null,
			textareaTop: textarea?.scrollTop, textareaMax: textarea ? textarea.scrollHeight - textarea.clientHeight : null,
			value: textarea?.value, selection: textarea ? [textarea.selectionStart, textarea.selectionEnd] : null,
			selected: root?.querySelector('[role="radio"][aria-checked="true"]')?.textContent,
			windowHeight: innerHeight };
	}, { scroller: SCROLLER, area: AREA, surface: SURFACE, field: testid(fixture.field), dock: testid(fixture.dock) });
}
function fit(s, label) {
	for (const key of ["surface", "question", "textarea", "submit", "transcript"]) assert.ok(s[key]?.height > 0, `${label}: missing/hidden ${key}; rebuild with dock markers`);
	assert.ok(s.surface.top >= s.transcript.top - 2, `${label}: active form top ${s.surface.top} above session viewport ${s.transcript.top}`);
	// The approved short-window fallback scrolls the whole bounded form:
	// its children need to be REACHABLE, not all simultaneously visible.
	// fallbackEdges() below verifies that reachability with native scrolling.
	for (const key of s.surfaceMax > 2 ? ["surface"] : ["surface", "question", "textarea", "submit"]) {
		assert.ok(s[key].top >= -2 && s[key].bottom <= Math.min(s.windowHeight, s.transcript.bottom) + 2,
			`${label}: ${key} clipped outside viewport: ${JSON.stringify(s[key])}`);
	}
	assert.ok(s.surface.height >= 24, `${label}: no readable whole-form viewport (${s.surface.height}px)`);
	assert.ok(s.question.height >= 24, `${label}: no usable question viewport (${s.question.height.toFixed(2)}px); surface=${JSON.stringify(s.surface)}, textarea=${JSON.stringify(s.textarea)}`);
	assert.ok(s.textarea.height >= 20, `${label}: no usable writing viewport`);
	assert.ok(s.transcriptMax > 500, `${label}: insufficient fixture history`);
}
/** Wait for actual geometry/scroll stability, not a guessed reveal-animation time. */
async function settled(page, fixture, label, requireBottom = false) {
	const started = Date.now();
	let previous, stableSince = 0, first;
	while (Date.now() - started < 5000) {
		const current = await snapshot(page, fixture);
		first ??= current;
		const values = (s) => [s.transcriptTop, s.transcriptMax, s.transcript?.width, s.transcript?.height,
			s.surface?.top, s.surface?.height, s.question?.top, s.question?.height, s.textarea?.height];
		const stable = previous && values(current).every((v, i) => Number.isFinite(v) && Math.abs(v - values(previous)[i]) < 0.5);
		if (!stable) stableSince = Date.now();
		const atBottom = current.transcriptMax - current.transcriptTop <= 2;
		if (stable && Date.now() - stableSince >= 500 && (!requireBottom || atBottom)) {
			log(`${fixture.name}: ${label} settled in ${Date.now() - started}ms; transcript ${first.transcriptTop.toFixed(1)} → ${current.transcriptTop.toFixed(1)}, max ${current.transcriptMax.toFixed(1)}, bottom gap ${(current.transcriptMax - current.transcriptTop).toFixed(1)}`);
			return current;
		}
		previous = current;
		await delay(80);
	}
	throw new Error(`${label}: geometry/scroll did not settle${requireBottom ? " at bottom" : ""}: ${JSON.stringify(previous)}`);
}
function unchangedTranscript(before, after, label) {
	assert.ok(Math.abs(after.transcriptTop - before.transcriptTop) <= 2,
		`${label}: transcript moved ${before.transcriptTop.toFixed(2)} → ${after.transcriptTop.toFixed(2)} (delta ${(after.transcriptTop - before.transcriptTop).toFixed(2)}; max ${before.transcriptMax} → ${after.transcriptMax}; question ${before.questionTop} → ${after.questionTop}; surface top ${before.surface?.top} → ${after.surface?.top})`);
}
async function wheel(page, selector, deltaY) {
	const box = await page.$eval(selector, (el) => {
		const r = el.getBoundingClientRect();
		return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
	});
	await page.mouse.move(box.x, box.y);
	await page.mouse.wheel({ deltaY });
	await delay(220);
}
/** In short windows the root, rather than an unusably tiny question slot,
 * scrolls. Verify the same content/containment contract through that surface. */
async function fallbackEdges(page, fixture, baseline) {
	const root = testid(fixture.dock);
	assert.ok(baseline.surfaceMax > 500, "whole-form fallback must actually overflow");
	assert.ok(baseline.questionMax <= 2, "whole-form fallback must leave question area unbounded, not nested-scroll it");
	log(`${fixture.name}: whole-form fallback (${baseline.surface.height.toFixed(1)}px viewport, ${baseline.surfaceMax}px overflow)`);
	await page.$eval(root, (el) => { el.scrollTop = 0; });
	const beforeTop = await snapshot(page, fixture);
	unchangedTranscript(baseline, beforeTop, "setting whole form to top");
	const questionPoint = await page.$eval(root, (el) => {
		const s = el.getBoundingClientRect(), q = el.querySelector("[data-dock-scroll-area]").getBoundingClientRect();
		const top = Math.max(s.top, q.top), bottom = Math.min(s.bottom, q.bottom);
		const point = { x: (Math.max(s.left, q.left) + Math.min(s.right, q.right)) / 2, y: (top + bottom) / 2 };
		return bottom - top >= 24 && el.querySelector("[data-dock-scroll-area]").contains(document.elementFromPoint(point.x, point.y)) ? point : null;
	});
	assert.ok(questionPoint, "whole-form question has no readable/hittable region");
	await page.mouse.move(questionPoint.x, questionPoint.y);
	await page.mouse.wheel({ deltaY: -600 });
	await delay(220);
	let s = await snapshot(page, fixture);
	fit(s, "whole-form top edge");
	assert.equal(s.surfaceTop, 0, "whole-form top boundary moved");
	unchangedTranscript(beforeTop, s, "wheel at whole-form top");
	const endpoint = async (last, scroll) => page.$eval(root, (el, { last, scroll }) => {
		const q = el.querySelector("[data-dock-scroll-area]");
		const walker = document.createTreeWalker(q, NodeFilter.SHOW_TEXT);
		let target;
		for (let n = walker.nextNode(); n; n = walker.nextNode()) {
			if (last && n.textContent.trim()) target = n;
			if (!last && n.textContent.includes("LAYOUT QUESTION START")) { target = n; break; }
		}
		if (!target) return false;
		const range = document.createRange(); range.selectNodeContents(target);
		const visible = el.getBoundingClientRect();
		if (scroll) el.scrollTop += range.getBoundingClientRect().bottom - visible.bottom + 2;
		const r = range.getBoundingClientRect();
		return r.top >= visible.top - 1 && r.bottom <= visible.bottom + 1;
	}, { last, scroll });
	assert.ok(await endpoint(false, false), "whole-form question's first text is not readable");
	await page.mouse.wheel({ deltaY: 300 });
	await delay(220);
	s = await snapshot(page, fixture);
	assert.ok(s.surfaceTop > 0, "wheel over question did not scroll whole-form root");
	assert.ok(s.questionTop <= 2, "whole-form fallback unexpectedly scrolled inner question");
	unchangedTranscript(beforeTop, s, "wheel inside whole-form question");
	assert.ok(await endpoint(true, true), "whole-form question's final text/option is unreachable");
	s = await snapshot(page, fixture);
	fit(s, "whole-form final question text");
	unchangedTranscript(baseline, s, "reaching whole-form question end");
	await page.$eval(root, (el) => { el.scrollTop = el.scrollHeight; });
	s = await snapshot(page, fixture);
	fit(s, "whole-form footer");
	assert.ok(Math.abs(s.surfaceTop - s.surfaceMax) <= 2, "whole-form bottom must be reachable");
	for (const key of ["textarea", "submit"]) {
		assert.ok(s[key].top >= s.surface.top - 2 && s[key].bottom <= s.surface.bottom + 2,
			`whole-form ${key} is not reachable at bottom: ${JSON.stringify(s[key])}`);
	}
	// The submit button has no inner scroller and remains visible at the
	// footer. Wheel over it (without clicking) to test the root boundary.
	const bottomPoint = await page.$eval(root, (el) => {
		const submit = el.querySelector('button[type="submit"], [data-testid="practice-send"]');
		if (!submit) return null;
		const r = submit.getBoundingClientRect(), x = (r.left + r.right) / 2, y = (r.top + r.bottom) / 2;
		return submit.contains(document.elementFromPoint(x, y)) ? { x, y } : null;
	});
	assert.ok(bottomPoint, "no footer hit target for whole-form bottom edge");
	await page.mouse.move(bottomPoint.x, bottomPoint.y);
	await page.mouse.wheel({ deltaY: 600 });
	await delay(220);
	const afterBottom = await snapshot(page, fixture);
	fit(afterBottom, "whole-form bottom edge");
	unchangedTranscript(baseline, afterBottom, "complete whole-form scroll sequence");
	assert.ok(Math.abs(afterBottom.surfaceTop - afterBottom.surfaceMax) <= 2, "whole-form bottom boundary moved");
}
async function edges(page, fixture) {
	const q = `${testid(fixture.dock)} ${AREA}`;
	const baseline = await settled(page, fixture, "before question-edge checks");
	if (baseline.surfaceMax > 2) return fallbackEdges(page, fixture, baseline);
	assert.ok(baseline.questionMax > 500, "long fixture must overflow question area");
	await page.$eval(q, (el) => { el.scrollTop = 0; });
	const beforeTopWheel = await snapshot(page, fixture);
	unchangedTranscript(baseline, beforeTopWheel, "setting question to top");
	await wheel(page, q, -600);
	let s = await snapshot(page, fixture);
	fit(s, "question top");
	unchangedTranscript(beforeTopWheel, s, "wheel at question top");
	assert.equal(s.questionTop, 0, "question start must be reachable");
	const topReadable = await page.$eval(q, (el) => {
		const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
		for (let n = walker.nextNode(); n; n = walker.nextNode()) {
			if (!n.textContent.includes("LAYOUT QUESTION START")) continue;
			const range = document.createRange(); range.selectNodeContents(n);
			const r = range.getBoundingClientRect(), a = el.getBoundingClientRect();
			return r.top >= a.top - 1 && r.bottom <= a.bottom + 1;
		}
		return false;
	});
	assert.ok(topReadable, "question's first text is not readable at top");
	const beforeInsideWheel = await snapshot(page, fixture);
	await wheel(page, q, 350);
	s = await snapshot(page, fixture);
	assert.ok(s.questionTop > 0, "wheel inside question did not scroll question");
	unchangedTranscript(beforeInsideWheel, s, "scrolling inside question");
	await page.$eval(q, (el) => { el.scrollTop = el.scrollHeight; });
	const beforeBottomWheel = await snapshot(page, fixture);
	unchangedTranscript(s, beforeBottomWheel, "setting question to bottom");
	await wheel(page, q, 600);
	s = await snapshot(page, fixture);
	fit(s, "question bottom");
	assert.ok(Math.abs(s.questionTop - s.questionMax) <= 2, "question end must be reachable");
	unchangedTranscript(beforeBottomWheel, s, "wheel at question bottom");
	unchangedTranscript(baseline, s, "complete question scroll sequence");
	const bottomReadable = await page.$eval(q, (el) => {
		const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
		let last;
		for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.textContent.trim()) last = n;
		if (!last) return false;
		const range = document.createRange(); range.selectNodeContents(last);
		const r = range.getBoundingClientRect(), a = el.getBoundingClientRect();
		return r.top >= a.top - 1 && r.bottom <= a.bottom + 1;
	});
	assert.ok(bottomReadable, "question's last text/option is not readable at bottom");
}
async function runCase(page, origin, fixture) {
	log(`${fixture.name}: open seeded session`);
	await page.setViewport({ width: 1280, height: 900 });
	await page.goto(`${origin}/chat/${fixture.id}`, { waitUntil: "domcontentloaded" });
	await page.waitForSelector(SCROLLER, { timeout: 5000 });
	if (fixture.kind !== "practice") {
		await page.waitForSelector(testid("teach-check-reveal"), { visible: true });
		await page.click(testid("teach-check-reveal"));
	}
	await page.waitForSelector(`${testid(fixture.dock)} ${AREA}`, { visible: true });
	fit(await settled(page, fixture, "initial reveal", true), "initial layout");
	log(`${fixture.name}: question scroll and edge-wheel containment`);
	await edges(page, fixture);
	if (fixture.quiz) await page.click(`${testid(fixture.dock)} [role="radio"]`);
	const field = `${testid(fixture.field)} textarea`;
	const before = await snapshot(page, fixture);
	const draft = Array.from({ length: 100 }, (_, i) => `Synthetic draft line ${i + 1}: pairing preserves the total.`).join("\n");
	await page.focus(field);
	await page.keyboard.sendCharacter(draft); // CDP Input.insertText: real input event, no React state/DOM patching.
	await delay(200);
	const filled = await snapshot(page, fixture);
	fit(filled, "large draft");
	assert.equal(filled.value, draft, "large draft was not accepted");
	assert.ok(Math.abs(filled.question.top - before.question.top) <= 2, "typing moved question top");
	assert.ok(Math.abs(filled.textarea.height - before.textarea.height) <= 2, "typing grew fixed textarea height");
	assert.ok(filled.textareaMax > 500, "large draft must overflow textarea");
	await page.$eval(field, (el) => { el.scrollTop = 0; });
	await wheel(page, field, 300);
	assert.ok((await snapshot(page, fixture)).textareaTop > 0, "textarea does not wheel-scroll");
	log(`${fixture.name}: fixed draft field and textarea scrolling passed`);

	await page.$eval(field, (el) => { el.setSelectionRange(7, 29); });
	const preserved = await settled(page, fixture, "before outside-history wheel");
	// Navigate history OUTSIDE the expanded surface, never inside the question.
	const outside = await page.evaluate(({ scroller, surface }) => {
		const t = document.querySelector(scroller), s = document.querySelector(surface);
		const r = t.getBoundingClientRect(), q = s.getBoundingClientRect();
		const candidates = [{ x: (r.left + r.right) / 2, y: r.top + 12 }, { x: r.left + 32, y: r.top + 12 }, { x: r.right - 32, y: r.top + 12 }];
		return candidates.find(({ x, y }) => (x < q.left || x > q.right || y < q.top || y > q.bottom) && t.contains(document.elementFromPoint(x, y)));
	}, { scroller: SCROLLER, surface: SURFACE });
	assert.ok(outside, "no transcript hit target outside expanded surface");
	await page.mouse.move(outside.x, outside.y);
	// A real wheel gesture is a sequence: the sticky-bottom library releases
	// following on the first event, and the fold observes subsequent motion.
	for (let i = 0; i < 3; i++) {
		await page.mouse.wheel({ deltaY: -300 });
		await delay(100);
	}
	log(`${fixture.name}: outside-history wheel at (${outside.x}, ${outside.y}); transcript ${preserved.transcriptTop} → ${await page.$eval(SCROLLER, (el) => el.scrollTop)}`);
	await page.waitForSelector(testid(fixture.bar), { visible: true, timeout: 3000 });
	const collapsedTop = await page.$eval(SCROLLER, (el) => el.scrollTop);
	assert.ok(collapsedTop < preserved.transcriptTop - 96, "outside wheel did not navigate history");
	await page.click(testid(fixture.bar));
	await page.waitForSelector(field, { visible: true });
	const reopened = await settled(page, fixture, "history reopen", true);
	fit(reopened, "reopened");
	assert.equal(reopened.value, draft, "collapse/reopen lost draft");
	// The approved selection invariant is the chosen quiz answer. Practice's
	// existing conditional render remounts its textarea, so caret retention is
	// diagnostic only, not a new product requirement imposed by this smoke.
	log(`${fixture.name}: caret range ${JSON.stringify(preserved.selection)} → ${JSON.stringify(reopened.selection)} (informational)`);
	if (fixture.quiz) {
		assert.ok(preserved.selected, "quiz selection was not established before collapse");
		assert.equal(reopened.selected, preserved.selected, "collapse/reopen lost quiz selection");
	}
	assert.equal(await page.$('[role="dialog"]'), null, "unexpected dialog (no submit/model action is allowed)");
	log(`${fixture.name}: outside-history collapse/reopen preserves draft and answer selection`);

	// Both sidebar buttons stay mounted; choose the actually hittable one,
	// not the hidden close button left in a zero-width sidebar.
	const oldWidth = reopened.transcript.width;
	const toggle = await page.evaluate(() => {
		for (const label of ["Close sidebar", "Open sidebar"]) {
			const button = document.querySelector(`button[aria-label="${label}"]`);
			if (!button) continue;
			const r = button.getBoundingClientRect();
			if (r.width && r.height && button.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2))) return `button[aria-label="${label}"]`;
		}
		return null;
	});
	assert.ok(toggle, "no hittable sidebar toggle");
	await page.click(toggle);
	const column = await settled(page, fixture, "column resize");
	fit(column, "column resized");
	assert.ok(Math.abs(column.transcript.width - oldWidth) > 100,
		`sidebar toggle did not resize session column (${oldWidth} → ${column.transcript.width})`);
	for (const viewport of [{ width: 960, height: 700 }, { width: 960, height: 480 }]) {
		await page.setViewport(viewport);
		const s = await settled(page, fixture, `resize ${viewport.width}x${viewport.height}`);
		fit(s, `window ${viewport.width}x${viewport.height}`);
		await edges(page, fixture);
	}
	log(`${fixture.name}: column resize, window resize and short-window readability — PASS`);
	if (fixture.quiz) {
		// Even when reading notes / stats consume the form budget, the outer
		// frame must scroll rather than assigning an invisible zero-height form.
		await page.setViewport({ width: 960, height: 240 });
		await settled(page, fixture, "extreme short-window frame");
		const frame = "[data-dock-frame-scroll]";
		await page.waitForSelector(frame, { visible: true });
		const point = await page.$eval(frame, (el) => {
			const r = el.getBoundingClientRect();
			if (r.top < 0 || r.bottom > innerHeight + 2 || r.height < 24) throw new Error("outer dock frame does not fit");
			el.scrollTop = 0;
			return { x: (r.left + r.right) / 2, y: r.top + 8 };
		});
		const history = await page.$eval(SCROLLER, (el) => el.scrollTop);
		await page.mouse.move(point.x, point.y);
		await page.mouse.wheel({ deltaY: 100 });
		await delay(220);
		assert.ok(await page.$eval(frame, (el) => el.scrollTop > 0), "outer frame cannot wheel-scroll");
		const questionPoint = await page.$eval(frame, (el) => {
			const form = el.querySelector('[data-testid="question-dock"]');
			el.scrollTop += form.getBoundingClientRect().top - el.getBoundingClientRect().top;
			form.scrollTop = 0;
			const r = form.getBoundingClientRect(), f = el.getBoundingClientRect();
			if (r.height < 24 || r.top < f.top - 2 || r.bottom > f.bottom + 2) throw new Error("form unreachable within outer frame");
			return { x: (r.left + r.right) / 2, y: r.top + Math.min(40, r.height / 2) };
		});
		await page.mouse.move(questionPoint.x, questionPoint.y);
		await page.mouse.wheel({ deltaY: 100 });
		await delay(220);
		assert.ok(await page.$eval(testid(fixture.dock), (el) => el.scrollTop > 0), "question cannot scroll inside the outer frame");
		assert.ok(Math.abs(await page.$eval(SCROLLER, (el) => el.scrollTop) - history) <= 2, "extreme-frame scrolling moved history");
		assert.equal(await page.$eval(field, (el) => el.value), draft);
		log("extreme short-window frame: native scrolling reaches the nonzero question form — PASS");
	}
}

async function main() {
	assert.ok(fs.existsSync(SERVER), "missing standalone server; build separately first");
	assert.ok(fs.existsSync(CHROME), `missing Chrome: ${CHROME}`);
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "lh-question-layout-"));
	const screenshotDir = shots ? fs.mkdtempSync(path.join(os.tmpdir(), "lh-question-layout-shots-")) : null;
	let child, browser, timer, serverLog = "";
	const forbidden = [];
	const failures = [];
	let interrupted = false;
	const interrupt = () => { interrupted = true; child?.kill("SIGTERM"); browser?.process()?.kill("SIGTERM"); };
	process.on("SIGINT", interrupt); process.on("SIGTERM", interrupt);
	try {
		seed(home);
		const audit = path.join(home, "blocked-network.log");
		const preload = path.join(home, "deny-network.mjs");
		fs.writeFileSync(preload, `import fs from 'node:fs'; import net from 'node:net'; import {syncBuiltinESMExports} from 'node:module';
const block = () => { fs.appendFileSync(${JSON.stringify(audit)}, 'blocked outbound request\\n'); throw new Error('question-layout smoke forbids outbound network'); };
net.Socket.prototype.connect = block; net.connect = block; net.createConnection = block; syncBuiltinESMExports(); globalThis.fetch = block;\n`);
		const port = await freePort(), origin = `http://127.0.0.1:${port}`;
		const env = { ...probeEnv(process.env, home), HOSTNAME: "127.0.0.1", PORT: String(port), NEXT_TELEMETRY_DISABLED: "1" };
		child = spawn(process.execPath, ["--import", pathToFileURL(preload).href, SERVER], { cwd: STANDALONE, env, stdio: ["ignore", "pipe", "pipe"] });
		let spawnError;
		child.once("error", (e) => { spawnError = e; });
		const keep = (chunk) => { serverLog = (serverLog + chunk).slice(-12000); };
		child.stdout.on("data", keep); child.stderr.on("data", keep);
		timer = setTimeout(interrupt, seconds * 1000);
		const deadline = Date.now() + Math.min(15000, seconds * 1000);
		for (;;) {
			if (spawnError) throw spawnError;
			if (interrupted || Date.now() > deadline || child.exitCode !== null) throw new Error("isolated server failed to boot before deadline");
			try { const res = await fetch(origin, { signal: AbortSignal.timeout(1500) }); if (res.ok) break; }
			catch (e) { if (!e.cause?.code?.startsWith("ECONN") && e.name !== "TimeoutError") throw e; }
			await delay(100);
		}
		log("isolated standalone server ready; browser and server forbid external/model traffic");
		browser = await puppeteer.launch({ executablePath: CHROME, headless: true, userDataDir: path.join(home, "chrome-profile"), env,
			args: ["--disable-background-networking", "--disable-component-update", "--disable-sync", "--no-first-run", "--no-proxy-server", "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost"] });
		for (const fixture of cases) {
			if (interrupted) throw new Error(`smoke interrupted or exceeded ${seconds}s`);
			const page = await browser.newPage();
			page.setDefaultTimeout(4000); page.setDefaultNavigationTimeout(8000);
			await page.setRequestInterception(true);
			page.on("request", (request) => {
				const url = new URL(request.url());
				const localRead = url.origin === origin && ["GET", "HEAD"].includes(request.method());
				if (localRead || ["data:", "blob:", "about:"].includes(url.protocol)) void request.continue();
				else { forbidden.push(`${request.method()} ${url.origin}${url.pathname}`); void request.abort("blockedbyclient"); }
			});
			try { await runCase(page, origin, fixture); }
			catch (error) { failures.push(`${fixture.name}: ${error.message}`); log(`FAIL ${failures.at(-1)}`); }
			finally {
				if (screenshotDir && !page.isClosed()) await page.screenshot({ path: path.join(screenshotDir, `${fixture.id}.png`) }).catch(() => {});
				await page.close().catch(() => {});
			}
		}
		assert.deepEqual(forbidden, [], "browser attempted forbidden external or mutating request");
		assert.ok(!fs.existsSync(audit), "server attempted forbidden outbound network");
		assert.ok(!interrupted, `smoke interrupted or exceeded ${seconds}s`);
		assert.equal(failures.length, 0, failures.join("\n"));
		log("PASS — all three synthetic sessions; no model calls, real credentials or real data");
	} catch (error) {
		console.error("--- standalone log tail ---\n" + serverLog);
		throw error;
	} finally {
		clearTimeout(timer);
		try { await browser?.close(); }
		catch { await stop(browser?.process()); }
		finally { await stop(child); fs.rmSync(home, { recursive: true, force: true }); }
		process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt);
		if (screenshotDir) log(`synthetic screenshots: ${screenshotDir}`);
	}
}
main().catch((error) => { console.error(`[smoke-question-layout] FAIL: ${error.message}`); process.exitCode = 1; });
