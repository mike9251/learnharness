/** One browser dictation run. No React, persistence, speech/key logging, or
 * model calls. Capture, socket, and finalization have separate lifetimes. */
export type DictationPhase = "idle" | "microphone" | "connecting" | "recording" | "stopping";
export const DICTATION_SETUP_MS = 30_000;
export const DICTATION_DRAIN_MS = 1_000;
export const DICTATION_FINAL_MS = 3_000;
const SILENCE_RMS = 10 ** (-50 / 20); // same floor as the existing meter
const MAX_PENDING_FRAMES = 256;

export interface DictationRunOptions {
	microphone(): Promise<MediaStream>;
	audioGraph(): { ctx: AudioContext; module: Promise<void> };
	worklet(ctx: AudioContext): AudioWorkletNode;
	token(fresh: boolean): Promise<string>;
	socket(token: string): WebSocket;
	onPhase(phase: DictationPhase): void;
	onLevel(rms: number): void;
	onTranscript(text: string): void;
	onEnd(error: string | null): void;
}

/** Public methods are ref-safe: Stop/finish never depend on a stale React phase. */
export class DictationRun {
	private ended = false;
	private stopRequested = false;
	private captureDrained = false;
	private captureStarted = false;
	private closeSent = false;
	private reconnects = 0;
	private stream: MediaStream | null = null;
	private source: MediaStreamAudioSourceNode | null = null;
	private capture: AudioWorkletNode | null = null;
	private ws: WebSocket | null = null;
	private socketListeners = new Map<WebSocket, () => void>();
	private pending: ArrayBuffer[] = [];
	private finals: string[] = [];
	private frames = 0;
	private maxRms = 0;
	private timers = new Set<ReturnType<typeof setTimeout>>();
	private setupTimer?: ReturnType<typeof setTimeout>;
	private drainTimer?: ReturnType<typeof setTimeout>;
	private disposeCaptureListeners: (() => void)[] = [];
	private resolveFinished!: () => void;
	readonly finished = new Promise<void>((resolve) => { this.resolveFinished = resolve; });

	constructor(private readonly options: DictationRunOptions) {}

	private timer(ms: number, action: () => void) {
		const timer = setTimeout(() => {
			this.timers.delete(timer);
			if (!this.ended) action();
		}, ms);
		this.timers.add(timer);
		return timer;
	}
	private clear(timer: ReturnType<typeof setTimeout> | undefined) {
		if (timer !== undefined) { clearTimeout(timer); this.timers.delete(timer); }
	}

	start(): void {
		if (this.ended) return;
		this.options.onPhase("microphone");
		this.setupTimer = this.timer(DICTATION_SETUP_MS, () => this.end(this.captureStarted
			? "Dictation could not connect to Deepgram in time. Please retry."
			: "Microphone startup timed out. Check Chrome’s microphone permission and retry."));
		void this.prepare();
	}

	private async prepare() {
		try {
			// All three operations start in the click's synchronous call stack.
			// In particular, resume() is not deferred until after a permission prompt.
			const token = this.options.token(false);
			void token.catch((error: unknown) => this.end(this.errorMessage(error, "Could not obtain a dictation token.")));
			const microphone = this.options.microphone().then((stream) => {
				if (this.ended) stream.getTracks().forEach((track) => track.stop());
				else this.stream = stream;
				return stream;
			});
			// A later graph failure must not leave a subsequently granted mic alive.
			void microphone.catch((error: unknown) => this.end(this.captureError(error)));
			const { ctx, module } = this.options.audioGraph();
			const resumed = ctx.state === "running" ? Promise.resolve() : ctx.resume();
			const [stream] = await Promise.all([microphone, module, resumed]);
			if (this.ended) return;
			const worklet = this.options.worklet(ctx);
			this.capture = worklet;
			worklet.port.onmessage = (event) => this.captureMessage(worklet, event.data);
			const processorError = () => this.end("The microphone audio processor failed. Please retry dictation.");
			worklet.addEventListener("processorerror", processorError);
			this.disposeCaptureListeners.push(() => worklet.removeEventListener("processorerror", processorError));
			for (const track of stream.getTracks()) {
				const ended = () => { if (!this.stopRequested) this.end("The microphone disconnected. Check Chrome’s input device and retry."); };
				track.addEventListener("ended", ended);
				this.disposeCaptureListeners.push(() => track.removeEventListener("ended", ended));
			}
			const stateChanged = () => {
				if (!this.stopRequested && ctx.state !== "running") this.end("Microphone capture was interrupted. Please retry dictation.");
			};
			ctx.addEventListener("statechange", stateChanged);
			this.disposeCaptureListeners.push(() => ctx.removeEventListener("statechange", stateChanged));
			this.source = ctx.createMediaStreamSource(stream);
			this.source.connect(worklet);
			worklet.connect(ctx.destination);
			this.captureStarted = true;
			this.options.onPhase("connecting");
			const credential = await token;
			if (!this.ended) this.openSocket(credential);
		} catch (error) {
			this.end(this.captureError(error));
		}
	}

	private captureMessage(worklet: AudioWorkletNode, message: { type?: string; rms?: number; buffer?: unknown; requestId?: number }) {
		if (this.ended || this.capture !== worklet || this.captureDrained) return;
		if (message.type === "level") {
			const rms = Number.isFinite(message.rms) ? Math.max(0, message.rms!) : 0;
			this.maxRms = Math.max(this.maxRms, rms);
			this.options.onLevel(rms);
		} else if (message.type === "audio") {
			const value = message.buffer;
			let frame: ArrayBuffer | undefined;
			if (value instanceof ArrayBuffer) frame = value;
			else if (ArrayBuffer.isView(value) && value.buffer instanceof ArrayBuffer) {
				frame = value.byteOffset === 0 && value.byteLength === value.buffer.byteLength
					? value.buffer : value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
			}
			if (!frame?.byteLength) return;
			this.frames++;
			this.pending.push(frame);
			if (this.pending.length > MAX_PENDING_FRAMES) {
				this.end("The speech connection could not keep up with microphone capture. Please retry.");
				return;
			}
			this.sendPending();
		} else if (message.type === "stopped" && message.requestId === 1 && this.stopRequested) {
			this.clear(this.drainTimer);
			this.captureDrained = true;
			this.releaseWorklet();
			this.finishSocketWhenReady();
		}
	}

	private openSocket(token: string) {
		if (this.ended) return;
		try {
			const ws = this.options.socket(token);
			this.ws = ws;
			const current = () => !this.ended && this.ws === ws;
			const disposers: (() => void)[] = [];
			this.socketListeners.set(ws, () => disposers.forEach((dispose) => dispose()));
			const listen = <K extends keyof WebSocketEventMap>(type: K, handler: (event: WebSocketEventMap[K]) => void) => {
				ws.addEventListener(type, handler);
				disposers.push(() => ws.removeEventListener(type, handler));
			};
			listen("open", () => {
				if (!current()) return;
				this.clear(this.setupTimer);
				if (!this.stopRequested) this.options.onPhase("recording");
				this.sendPending();
				this.finishSocketWhenReady();
			});
			listen("message", (event) => {
				if (!current()) return;
				let message;
				try { message = JSON.parse(String(event.data)); } catch { return; }
				if (message.type === "Error") { this.end("Deepgram reported a transcription error. Please retry."); return; }
				const text = message.channel?.alternatives?.[0]?.transcript;
				if (message.type === "Results" && message.is_final && typeof text === "string" && text.trim()) this.finals.push(text);
			});
			listen("close", (event) => {
				if (!current()) return;
				if (event.code === 1000 && this.closeSent) this.end(null);
				else if (this.stopRequested) this.end("The speech connection closed before transcription finished.");
				else if (event.code === 1000) this.end("Deepgram ended the speech connection unexpectedly. Please retry.");
				else this.reconnect(ws);
			});
			listen("error", () => { if (current()) this.reconnect(ws); });
		} catch {
			this.end("Could not open the Deepgram speech connection. Please retry.");
		}
	}

	private releaseSocket(socket: WebSocket) {
		this.socketListeners.get(socket)?.();
		this.socketListeners.delete(socket);
		try { socket.close(); } catch { /* already closed */ }
	}

	private reconnect(socket: WebSocket) {
		if (this.ended || this.ws !== socket) return;
		if (this.stopRequested) { this.end("The speech connection failed while finishing transcription."); return; }
		if (this.reconnects++ >= 1) { this.end("The Deepgram speech connection failed. Please retry."); return; }
		this.ws = null; // invalidate old socket callbacks before closing it
		this.releaseSocket(socket);
		this.options.onPhase("connecting");
		this.clear(this.setupTimer);
		this.setupTimer = this.timer(DICTATION_SETUP_MS, () => this.end("Reconnecting to Deepgram timed out. Please retry."));
		void this.options.token(true).then((token) => { if (!this.ended) this.openSocket(token); })
			.catch(() => this.end("Could not reconnect to Deepgram. Please retry."));
	}

	private sendPending() {
		if (this.ended || this.closeSent || this.ws?.readyState !== 1) return;
		try {
			while (this.pending.length) {
				this.ws.send(this.pending[0]!);
				this.pending.shift();
			}
		} catch {
			if (this.ws) this.reconnect(this.ws);
		}
	}

	stop(): void {
		if (this.ended || this.stopRequested) return;
		this.stopRequested = true;
		this.options.onPhase("stopping");
		if (!this.capture) { this.end("The microphone was not ready before Stop. Start dictation again and wait for Listening."); return; }
		// Stop hardware immediately, but keep the worklet's port alive until
		// its ordered final-frame/ack pair has arrived. No PCM after CloseStream.
		this.source?.disconnect();
		this.source = null;
		this.stream?.getTracks().forEach((track) => track.stop());
		this.stream = null;
		this.drainTimer = this.timer(DICTATION_DRAIN_MS, () => this.end("Microphone capture could not finish cleanly. Please retry."));
		try { this.capture.port.postMessage({ type: "stop", requestId: 1 }); }
		catch { this.end("Microphone capture could not finish cleanly. Please retry."); }
	}

	private finishSocketWhenReady() {
		if (this.ended || !this.stopRequested || !this.captureDrained || this.closeSent || this.ws?.readyState !== 1) return;
		this.sendPending();
		if (this.ended || this.pending.length || this.ws?.readyState !== 1) return;
		try {
			this.closeSent = true;
			this.ws.send(JSON.stringify({ type: "CloseStream" }));
			if (!this.ended) this.timer(DICTATION_FINAL_MS, () => this.end("Timed out waiting for the final transcription. Any completed text has been kept."));
		} catch { this.end("Could not finish the speech connection. Any completed text has been kept."); }
	}

	cancel(): void { this.end(null, true); }

	private releaseWorklet() {
		const worklet = this.capture;
		this.capture = null;
		if (!worklet) return;
		worklet.port.onmessage = null;
		try { worklet.port.close(); } catch { /* already closed */ }
		try { worklet.disconnect(); } catch { /* already disconnected */ }
	}

	private end(error: string | null, discard = false) {
		if (this.ended) return;
		this.ended = true;
		for (const timer of this.timers) clearTimeout(timer);
		this.timers.clear();
		for (const dispose of this.disposeCaptureListeners) dispose();
		this.disposeCaptureListeners = [];
		this.stream?.getTracks().forEach((track) => track.stop());
		this.stream = null;
		this.source?.disconnect();
		this.source = null;
		this.releaseWorklet();
		this.ws = null;
		for (const socket of this.socketListeners.keys()) this.releaseSocket(socket);
		this.pending = [];
		const text = this.finals.join(" ");
		this.finals = [];
		if (!discard && !error && !text) {
			error = this.frames === 0 ? "No microphone audio was captured. Check Chrome’s microphone access and retry."
				: this.maxRms <= SILENCE_RMS ? "Chrome supplied silent microphone audio. Check microphone access, input volume, or try another input."
					: "No speech was transcribed. Please try speaking again.";
		}
		try {
			if (!discard && text) this.options.onTranscript(text);
		} finally {
			try {
				this.options.onPhase("idle");
				this.options.onEnd(discard ? null : error);
			} finally { this.resolveFinished(); }
		}
	}

	private errorMessage(error: unknown, fallback: string) { return error instanceof Error ? error.message : fallback; }
	private captureError(error: unknown) {
		if (error instanceof Error && (error.name === "NotAllowedError" || error.name === "SecurityError")) return "Microphone permission denied. Allow microphone access for this site in Chrome and macOS.";
		if (error instanceof Error && error.name === "NotFoundError") return "Chrome could not find a microphone. Check its selected input device.";
		if (error instanceof Error && error.name === "NotReadableError") return "Chrome could not start the microphone. Check whether another app is using it and retry.";
		return "Could not start microphone capture. Check Chrome’s microphone access and retry.";
	}
}
