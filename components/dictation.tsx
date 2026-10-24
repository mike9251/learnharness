"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2Icon, MicIcon } from "lucide-react";
import { useSettingsDialog } from "@/components/settings/settings-dialog";
import { Hint } from "@/components/ui/hint";
import { DictationRun, type DictationPhase } from "@/components/dictation-run";

export type { DictationPhase } from "@/components/dictation-run";

/**
 * Voice dictation — the cloud engine (STT wave 1, 2026-09-17).
 *
 * Architecture (docs/research/stt.md): the renderer captures mic audio in
 * an AudioWorklet (public/worklets/pcm-capture.js → linear16 16kHz mono),
 * opens the Deepgram streaming WebSocket DIRECTLY (audio never loops
 * through our server) with a short-lived token minted by /api/stt/token
 * (the real key stays server-side), and streams frames while it listens.
 * Finals append into the PRIMARY INPUT (see below).
 *
 * Ported patterns from the owner's pi `dictate` extension (his words:
 * "very well tuned") — see ~/.pi/agent/extensions/dictate:
 *   - run-owned capture/socket callbacks ignore retired resources, so a
 *     dying session cannot inject audio into or tear down the next run.
 *   - meter: latest-RMS-never-resets — the level ref keeps the last
 *     observed value, so a tick with no fresh audio re-renders the last
 *     level instead of dropping to silence (60ms tick samples the ref).
 *   - dB mapping floor −50 / ceiling −10: the sweet spot for showing
 *     conversational speech as mid-height bars without pegging.
 *   - stop: hardware capture stops, the worklet drains its partial frame,
 *     queued PCM reaches the socket, then CloseStream requests the finals.
 *     Startup/drain/finalization waits are bounded and failures are visible.
 *   - interim_results=false, endpointing=300: his live-tuned params — no
 *     partial hypotheses, finals commit ~300ms after a pause (owner
 *     round 1: live words are distracting and shift the meter; the
 *     meter's width is FIXED while recording).
 *
 * Owner round 2 (2026-09-17, second live test):
 *   - DEFERRED transcript: finals accumulate in a buffer during the run
 *     and flush into the primary input ONCE, when the dictation ends
 *     (Stop → Deepgram flushes its last finals → socket close → one
 *     joined append). Escape cancels and discards. Nothing textual renders while recording —
 *     only the meter. Live output may return as a toggleable setting at
 *     the settings milestone; deferred is the only behavior for now.
 *   - ADAPTIVE meter: the strip's cell count derives from its measured
 *     width (4px pitch, 8–48 cells, ResizeObserver) so narrow rows (the
 *     draft view's tighter column) show fewer bars instead of
 *     overflowing under their neighbors.
 *
 * Owner round 1 (2026-09-17, first live mic test):
 *   - ONE primary transcription input at all times: the pending
 *     quiz/ask question's field while one waits (text mode → the answer
 *     field, select modes → "Your thinking"), else the page's composer.
 *     Implemented as a module-level registry the question form claims on
 *     mount — see useDictationTarget below.
 *   - Click → status/meter immediately. Starting microphone, Connecting,
 *     Listening, and Finishing are distinguished explicitly. Token mint,
 *     microphone acquisition, module loading and context resume overlap.
 *
 * Meter rendering lives in <DictationBar> (own 60ms timer over the level
 * ref) so the 16-renders/sec never touch the page component — only the
 * tiny bar strip repaints.
 *
 * Start-latency mitigation wave (owner, 2026-09-27 — A+B+C+D, the
 * optimistic meter stays): the old start path serialized [token ∥ mic] →
 * NEW AudioContext → addModule fetch → WSS handshake, and DROPPED every
 * frame that arrived before the socket was OPEN — the first seconds of
 * speech never reached Deepgram. Now:
 *   - QUEUE-DON'T-DROP (A): frames arriving before OPEN buffer and flush
 *     in order on open, even after Stop. Buffer exhaustion fails visibly
 *     rather than silently discarding the beginning of the recording.
 *   - MIC-GATED HANDSHAKE (B): the socket opens only after capture and
 *     the token are ready; a permission prompt cannot consume Deepgram's
 *     audio idle timeout. Stop during connection preserves captured PCM.
 *   - PERSISTENT GRAPH (C): one app-lifetime AudioContext + a memoized
 *     worklet module — per-run contexts paid context creation AND a
 *     worklet-module fetch on every start (through the dev server in dev).
 *   - WARM TOKEN (D): pre-minted at page mount and refreshed after every
 *     run (TTL 3min); the click no longer waits on the remote mint. A
 *     stale-token handshake failure self-heals via the reconnect-once
 *     path, which always mints FRESH.
 *   - The honest floor stays: getUserMedia can't be pre-warmed (the mic
 *     indicator would stay lit) — hence the owner's optimistic meter.
 */

/*
 * Deepgram streaming params (the owner's live-tuned dictate config): nova-3,
 * endpointing=300, no interims. Silence streams too (the worklet never
 * pauses), so the socket never idles — no KeepAlive needed.
 */
const DG_URL =
	"wss://api.deepgram.com/v1/listen" +
	"?model=nova-3" +
	"&encoding=linear16" +
	"&sample_rate=16000" +
	"&channels=1" +
	"&smart_format=true" +
	"&punctuate=true" +
	"&endpointing=300";

/** Meter tuning — the owner's tested values, see the file header. */
const METER_FLOOR_DB = -50;
const METER_CEILING_DB = -10;
export const METER_TICK_MS = 60;
/** Rolling history: 48 cells × 60ms ≈ 2.9s of recent loudness. */
export const METER_CELLS = 48;

/** The Deepgram key's id in the keys store (the env-var name — the Keys
 *  section's openRow state and the PUT /api/keys/:id seam). */
export const DEEPGRAM_KEY_ID = "DEEPGRAM_API_KEY";

/** The client-authored KEYLESS line (zero-keys wave, owner 2026-09-25):
 * the token route's raw 503 message is dev-speak ("add it to auth.json
 * (desktop) or .env.local (dev)") — the surface says the short truth
 * instead. Exported for pins; the errored idle button's click recognizes
 * it and deep-links Settings → Keys → the Deepgram row. */
export const DICTATION_KEYLESS = "Dictation needs a Deepgram key";

/** Mint a fresh short-lived token (the route holds the real key
 *  server-side). Module-level: the start path's warm cache and the
 *  reconnect path both bottom out here. The keyless 503 (no
 *  DEEPGRAM_API_KEY) is the route's ONLY 503 — the raw message is
 *  dev-speak, so the error becomes the short client-authored line
 *  (zero-keys wave, owner 2026-09-25). */
async function mintFreshToken(): Promise<string> {
	const res = await fetch("/api/stt/token");
	const data = (await res.json()) as { token?: string; message?: string };
	if (!res.ok || !data.token) {
		if (res.status === 503) throw new Error(DICTATION_KEYLESS);
		throw new Error(data.message ?? `token route ${res.status}`);
	}
	return data.token;
}

/** Warm-token cache (mitigation D, owner 2026-09-27): the click path takes
 *  the cached promise instead of a remote mint. TTL keeps a cached token
 *  from going stale (self-heal anyway: a rejected handshake rides the
 *  reconnect-once path with a FRESH mint); a failed mint resets the cache
 *  so the next call re-mints — the honest error path stays honest.
 *  refresh() re-mints in the background (page mount, run end); its
 *  failures are silently tolerated (a keyless pre-mint just doesn't warm). */
export const WARM_TOKEN_TTL_MS = 3 * 60_000;

export type WarmMinter = { mint: () => Promise<string>; refresh: () => void };

export function createWarmMinter(
	mint: () => Promise<string>,
	now: () => number = Date.now,
	ttlMs: number = WARM_TOKEN_TTL_MS,
): WarmMinter {
	let warm: { p: Promise<string>; at: number } | null = null;
	const m: WarmMinter = {
		mint: () => {
			if (!warm || now() - warm.at > ttlMs) {
				const p = mint().catch((e: unknown) => {
					warm = null; // failed mint: next call re-mints
					throw e;
				});
				warm = { p, at: now() };
			}
			return warm.p;
		},
		refresh: () => {
			warm = null;
			m.mint().catch(() => {}); // background best-effort
		},
	};
	return m;
}

const warmTokens = createWarmMinter(mintFreshToken);

/* Persistent capture graph (mitigation C, owner 2026-09-27): one
 * app-lifetime AudioContext + a module-load memo. Created under the
 * click gesture (autoplay policy) and NEVER closed — per-run nodes
 * (source, worklet) disconnect at teardown instead. */
let sharedCtx: AudioContext | null = null;
let workletModule: Promise<void> | null = null;

function ensureAudioGraph(): { ctx: AudioContext; module: Promise<void> } {
	if (!sharedCtx) sharedCtx = new AudioContext({ sampleRate: 16000 });
	if (!workletModule) {
		workletModule = sharedCtx.audioWorklet.addModule("/worklets/pcm-capture.js").catch((e: unknown) => {
			workletModule = null; // failed load: retry next run
			throw e;
		});
	}
	return { ctx: sharedCtx, module: workletModule };
}

/** RMS (0..1) → normalized 0..1 across the audible dB window. */
export function rmsToMeter(rms: number): number {
	if (rms <= 0) return 0;
	const db = 20 * Math.log10(rms);
	const t = (db - METER_FLOOR_DB) / (METER_CEILING_DB - METER_FLOOR_DB);
	return Math.max(0, Math.min(1, t));
}

/**
 * The primary-input registry: at most ONE non-composer input can claim the
 * dictation target while mounted — the pending question's answer/thinking
 * field (question-dock.tsx). The page's `append` (the composer) is the
 * fallback when nobody claims. Module-level by design: the claimant is a
 * sibling subtree far from the hook's owner, and there is exactly one
 * window, one pending question, one target at a time.
 */
let questionTarget: ((text: string) => void) | null = null;

/* Is a dictation run live on this page? The Esc chain (keyboard wave A,
 * components/keyboard-shortcuts.tsx) needs a SYNCHRONOUS answer — the
 * stop handler can't report back through a CustomEvent. Set at start(),
 * cleared in cleanup() (every terminal path runs through cleanup). */
let dictationActiveFlag = false;

export function isDictationActive(): boolean {
	return dictationActiveFlag;
}

/* The finisher registry: submit paths FAR from the hook's owner (the
 * pending question's dock) need finish() without a prop bridge. Same
 * module-level pattern as questionTarget — one window, one instance,
 * one finisher. Empty registry (no hook mounted) → resolve immediately. */
let dictationFinisher: (() => Promise<void>) | null = null;

/** Finish any live dictation run before continuing (see Dictation.finish). */
export function finishDictation(): Promise<void> {
	return dictationFinisher ? dictationFinisher() : Promise.resolve();
}

/** Join a dictated final onto the current text (shared separator rule). */
export function joinDictation(current: string, final: string): string {
	return current ? current.replace(/\s+$/, "") + " " + final : final;
}

/**
 * Claim the dictation target while mounted (and `claimed` is true). The
 * unmount guard is identity-based so dev-mode double-invoked effects
 * can't clear another claimant.
 */
export function useDictationTarget(append: (text: string) => void, claimed: boolean) {
	useEffect(() => {
		if (!claimed) return;
		questionTarget = append;
		return () => {
			if (questionTarget === append) questionTarget = null;
		};
	}, [append, claimed]);
}

export type Dictation = {
	phase: DictationPhase;
	/** Terminal-state explanation, shown inside the wide button (cleared on the next start). */
	error: string | null;
	/** Latest observed RMS, 0..1 — sampled by the meter's own tick, never reset. */
	levelRef: { current: number };
	/** Not idle — from the click until the stop completes (the optimistic window). */
	active: boolean;
	/** End + KEEP the transcript: flush the deferred buffer into the primary
	 *  input (the Stop pill and ⌘D). */
	toggle: () => void;
	stop: () => void;
	/** FINISH, THEN CONTINUE (owner, 2026-10-01 "nothing gets lost" round):
	 *  if a run is live, stop it and resolve only when the run has fully
	 *  ended — Deepgram's last finals have landed in the target field. A
	 *  submit path awaits this before building its payload, so a learner
	 *  who forgets to stop dictation before Enter never loses the spoken
	 *  reasoning. Idle → resolves immediately (the common no-run submit
	 *  pays nothing). Every terminal path runs cleanup(), and cleanup()
	 *  resolves the waiters — cancel (Esc) resolves them too, by its
	 *  discard semantics. */
	finish: () => Promise<void>;
	/** End + DISCARD the transcript: no flush, immediate teardown. The Esc
	 *  semantics (owner, 2026-09-17 round 3): Esc is a cancel, not a stop —
	 *  before, it flushed exactly like the toggle did. */
	cancel: () => void;
	/** Clear the terminal error without starting a run (zero-keys wave):
	 * the keyless click leaves for Settings and the surface must come
	 * back clean. */
	clearError: () => void;
};

/**
 * One dictation instance per composer-bearing page. `append` is the
 * composer fallback; the mounted question form's claim wins while a
 * question waits.
 */
export function useDictation({ append }: { append: (text: string) => void }): Dictation {
	const [phase, setPhase] = useState<DictationPhase>("idle");
	const [error, setError] = useState<string | null>(null);
	const levelRef = useRef(0);
	const appendRef = useRef(append);
	appendRef.current = append;
	const runRef = useRef<DictationRun | null>(null);
	const mountedRef = useRef(false);

	const start = useCallback(() => {
		if (!mountedRef.current || runRef.current) return;
		setError(null);
		const run = new DictationRun({
			microphone: () => navigator.mediaDevices.getUserMedia({
				audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
			}),
			audioGraph: ensureAudioGraph,
			worklet: (ctx) => new AudioWorkletNode(ctx, "pcm-capture"),
			token: (fresh) => fresh ? mintFreshToken() : warmTokens.mint(),
			// Minted JWTs use bearer; the token subprotocol is for raw API keys.
			socket: (token) => new WebSocket(DG_URL, ["bearer", token]),
			onPhase: (next) => {
				if (mountedRef.current && runRef.current === run) setPhase(next);
			},
			onLevel: (rms) => {
				if (mountedRef.current && runRef.current === run) levelRef.current = rms;
			},
			onTranscript: (text) => {
				if (mountedRef.current && runRef.current === run) {
					(questionTarget ?? appendRef.current)(text);
				}
			},
			onEnd: (reason) => {
				if (runRef.current !== run) return;
				runRef.current = null;
				dictationActiveFlag = false;
				if (mountedRef.current) {
					setError(reason);
					warmTokens.refresh();
				}
			},
		});
		runRef.current = run;
		dictationActiveFlag = true;
		// No await here: the engine starts/resumes capture in the click stack.
		run.start();
	}, []);

	const stop = useCallback(() => { runRef.current?.stop(); }, []);
	const cancel = useCallback(() => { runRef.current?.cancel(); }, []);
	const finish = useCallback((): Promise<void> => {
		const run = runRef.current;
		if (!run) return Promise.resolve();
		run.stop();
		return run.finished;
	}, []);
	const toggle = useCallback(() => {
		if (runRef.current) runRef.current.stop();
		else start();
	}, [start]);

	useEffect(() => {
		mountedRef.current = true;
		dictationFinisher = finish;
		warmTokens.refresh();
		return () => {
			// Navigation/Strict Mode teardown discards, never flushes into a
			// departing page or the next page's newly registered target.
			mountedRef.current = false;
			if (dictationFinisher === finish) dictationFinisher = null;
			runRef.current?.cancel();
		};
	}, [finish]);
	useEffect(() => {
		window.addEventListener("lh:kbd-toggle-dictation", toggle);
		return () => window.removeEventListener("lh:kbd-toggle-dictation", toggle);
	}, [toggle]);
	useEffect(() => {
		window.addEventListener("lh:kbd-cancel-dictation", cancel);
		return () => window.removeEventListener("lh:kbd-cancel-dictation", cancel);
	}, [cancel]);

	return {
		phase,
		error,
		levelRef,
		active: phase !== "idle",
		toggle,
		stop,
		finish,
		cancel,
		clearError: () => setError(null),
	};
}

/**
 * The stats-bar dictation slot (owner placement, round 1): the row's middle
 * is one strip that is always the full free width —
 *
 *   idle      a wide, quiet "Dictate" button (mic + label, grayed out — the
 *             whole middle is the affordance, per the owner).
 *   active    optimistic from the CLICK: red stop pill + the fixed-width
 *             meter with a compact startup/listening/finishing status
 *             (no interim transcript). Spinner while the last final flushes.
 *   error     the wide button again, label swapped for the failure reason
 *             (full text in the tooltip), cleared on the next click.
 */
export function DictationBar({ dictation }: { dictation: Dictation }) {
	const { phase, error, levelRef, toggle, active, clearError } = dictation;
	const { open: openSettings } = useSettingsDialog();
	/** The keyless click (zero-keys wave, owner dictation trio): the errored
	 *  idle button deep-links Settings → Keys → the Deepgram row and clears
	 *  the error — the surface is clean when the user returns. Any other
	 *  error keeps the old behavior (click = retry, which clears). */
	const keyless = error === DICTATION_KEYLESS;
	const [levels, setLevels] = useState<number[]>(() => new Array(METER_CELLS).fill(0));
	const stage = {
		idle: "",
		microphone: "Starting microphone…",
		connecting: "Connecting…",
		recording: "Listening…",
		stopping: "Finishing…",
	}[phase];
	/** Adaptive cell count (owner round 2): derived from the meter's
	 *  measured width — narrow rows show fewer bars instead of
	 *  overflowing under neighbors. */
	const [cellCount, setCellCount] = useState(METER_CELLS);
	const meterRef = useRef<HTMLDivElement | null>(null);

	// The meter's own heartbeat — 60ms samples of the level ref into a
	// rolling ring. Only THIS strip re-renders; the page never does.
	useEffect(() => {
		if (!active) return;
		setLevels(new Array(METER_CELLS).fill(0));
		const id = setInterval(() => {
			setLevels((ring) => {
				const next = ring.slice(1);
				next.push(rmsToMeter(levelRef.current));
				return next;
			});
		}, METER_TICK_MS);
		return () => clearInterval(id);
	}, [active, levelRef]);

	// Fit the cell count to the available width (4px pitch per cell:
	// 2px bar + 2px gap, clamped 8..48). The meter div's width is set by
	// the row's free space — cells carry no minimum width — so measuring
	// it once per activation + on resize keeps the strip honest in the
	// draft/home rows where the slider leaves little middle.
	useEffect(() => {
		if (!active) return;
		const el = meterRef.current;
		if (!el) return;
		const fit = () => {
			const w = el.clientWidth;
			setCellCount(Math.max(8, Math.min(METER_CELLS, Math.floor(w / 4))));
		};
		fit();
		const ro = new ResizeObserver(fit);
		ro.observe(el);
		return () => ro.disconnect();
	}, [active]);

	if (!active) {
		return (
			<Hint
				// Errored: the button span truncates the line — the tooltip is its
				// full reveal (the keyless line KEEPS "Deepgram" — owner overrule:
				// it's the Keys row label, the truth the user needs). Otherwise the
				// quiet label + the live ⌘D binding.
				label={error ?? "Dictate"}
				action={error ? undefined : "toggle-dictation"}
				side="top"
			>
				<button
					type="button"
					onClick={() => {
						if (keyless) {
							clearError();
							openSettings("keys", DEEPGRAM_KEY_ID);
						} else {
							toggle();
						}
					}}
					aria-label={error ? `Dictation failed: ${error}` : "Start dictation"}
					data-testid="dictation-toggle"
				// Same blurring as the floating chrome (owner, fix wave round 3),
			// but lower opacity — the mic stays quieter than the model pills.
			className="flex h-7 w-full items-center justify-center gap-1.5 rounded-md border border-border/50 bg-card/50 text-xs text-muted-foreground/70 shadow-lg backdrop-blur transition-colors hover:border-border hover:text-muted-foreground"
			>
					<MicIcon className="size-3.5" />
					<span className="max-w-full truncate">{error ?? "Dictate"}</span>
				</button>
			</Hint>
		);
	}

	return (
		<div className="flex w-full min-w-0 items-center gap-2" data-testid="dictation-bar">
			<Hint
				label="Stop and keep transcription. Escape cancels and discards."
				side="top"
			>
				<button
					type="button"
					onClick={toggle}
					disabled={phase === "stopping"}
					aria-label="Stop dictation"
				data-testid="dictation-toggle"
				className="flex h-7 shrink-0 items-center gap-1.5 rounded-md bg-destructive/10 px-2 text-xs font-medium text-destructive transition-colors hover:bg-destructive/20"
			>
				{phase === "stopping" ? (
					<Loader2Icon className="size-3.5 animate-spin" />
				) : (
					<MicIcon className="size-3.5" />
				)}
					Stop
				</button>
			</Hint>
			<span className="size-1.5 shrink-0 animate-pulse rounded-full bg-destructive" aria-hidden />
			<span role="status" aria-live="polite" className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">
				{stage}
			</span>
			{/* Only the stage label sits beside the meter — never interim text.
			    Cells carry no minimum width; their count adapts to the remaining
			    row space (owner round 2). */}
			<div ref={meterRef} className="flex h-4 min-w-0 flex-1 items-center gap-[2px]" data-testid="dictation-meter">
				{levels.slice(-cellCount).map((v, i) => (
					<span
						key={i}
						className="min-w-0 flex-1 rounded-full bg-foreground/40"
						style={{ height: `${2 + Math.round(v * 14)}px` }}
					/>
				))}
			</div>
		</div>
	);
}
