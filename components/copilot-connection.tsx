"use client";

import { useEffect, useRef, useState } from "react";
import type { CopilotLoginStatus, CopilotStatus } from "@/src/core";
import { notifySettingsSaved } from "@/components/settings-signal";

const AUTH = "/api/auth/github-copilot";
const buttonClass = "rounded-sm border border-border bg-background px-3 py-1.5 font-ui text-xs text-foreground hover:border-muted-foreground/50 disabled:opacity-40";
const pending = (status: CopilotLoginStatus) => status.state === "starting" || status.state === "waiting";

interface Attempt {
	id?: string;
	cancelled: boolean;
	terminal: boolean;
	cancelSent: boolean;
	completionNotified?: boolean;
	timer?: ReturnType<typeof setTimeout>;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
	const response = await fetch(url, init);
	const body = await response.json();
	if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`);
	return body as T;
}

/** Each mounted surface owns its login capability, including a POST whose
 * response arrives after close. Never abort that POST: we need its id to cancel.
 * A completed login is terminal before emitting the signal (which can unmount us).
 */
export function CopilotConnection({ setup = false }: { setup?: boolean }) {
	const [connected, setConnected] = useState<boolean | null>(null);
	const [login, setLogin] = useState<CopilotLoginStatus | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [copied, setCopied] = useState(false);
	const [retry, setRetry] = useState<"status" | "login" | "disconnect" | "cancel">("status");
	const mounted = useRef(false);
	const statusRead = useRef(0);
	const attempt = useRef<Attempt | null>(null);

	function cancellationError(a: Attempt, err: unknown) {
		if (a.terminal || !mounted.current || attempt.current !== a) return;
		setBusy(false);
		setRetry("cancel");
		setError(err instanceof Error ? err.message : "Could not cancel login.");
	}

	async function cancelRemote(a: Attempt) {
		if (!a.id || a.terminal || a.cancelSent) return;
		a.cancelSent = true;
		try {
			receive(a, await request<CopilotLoginStatus>(`${AUTH}/login/${encodeURIComponent(a.id)}`, { method: "DELETE" }));
		} catch (err) {
			// A failed DELETE is not proof of cancellation. Read back once, even
			// after unmount, to discover a login that completed in the meantime.
			try {
				receive(a, await request<CopilotLoginStatus>(`${AUTH}/login/${encodeURIComponent(a.id)}`));
			} catch { /* Keep the cancellation error; Retry reconciles this id. */ }
			cancellationError(a, err);
		} finally {
			a.cancelSent = false;
		}
	}

	async function reconcileCancellation() {
		const a = attempt.current;
		if (!a || !a.id || a.terminal) return;
		setBusy(true);
		setError(null);
		try {
			// Retry the existing capability, never POST another active login.
			receive(a, await request<CopilotLoginStatus>(`${AUTH}/login/${encodeURIComponent(a.id)}`));
		} catch (err) { cancellationError(a, err); }
	}

	function stop(a: Attempt) {
		a.cancelled = true;
		clearTimeout(a.timer);
		void cancelRemote(a);
	}

	async function loadStatus() {
		const read = ++statusRead.current;
		setBusy(true);
		setError(null);
		setRetry("status");
		try {
			const status = await request<CopilotStatus>(AUTH);
			if (mounted.current && read === statusRead.current) setConnected(status.connected);
		} catch (err) {
			if (mounted.current && read === statusRead.current) setError(err instanceof Error ? err.message : "Could not load connection status.");
		} finally {
			if (mounted.current && read === statusRead.current) setBusy(false);
		}
	}

	useEffect(() => {
		mounted.current = true;
		void loadStatus();
		return () => {
			mounted.current = false;
			statusRead.current++;
			if (attempt.current) stop(attempt.current);
		};
	}, []);

	function receive(a: Attempt, status: CopilotLoginStatus) {
		a.id = status.id;
		if (status.state === "connected") {
			// DELETE and an already in-flight poll can both discover completion.
			// Reconcile once, even after close, without deleting completed auth.
			if (a.completionNotified) return;
			a.completionNotified = true;
			a.terminal = true;
			clearTimeout(a.timer);
			if (mounted.current && attempt.current === a) {
				setLogin(status);
				setConnected(true);
				setError(null);
				setBusy(false);
			}
			notifySettingsSaved("keys");
			return;
		}
		// A stale pending response must never undo a terminal cancellation or
		// successful completion, nor restart polling after either one.
		if (a.terminal) return;
		a.terminal = !pending(status);
		if (a.terminal) clearTimeout(a.timer);
		if (a.cancelled || !mounted.current || attempt.current !== a) {
			if (!a.terminal) void cancelRemote(a);
			else if (mounted.current && attempt.current === a) {
				setLogin(status);
				setBusy(false);
				setRetry("login");
				if (status.error) setError(status.error);
			}
			return;
		}
		setLogin(status);
		if (pending(status)) {
			a.timer = setTimeout(() => { void poll(a); }, 2000);
		} else {
			setBusy(false);
			setError(status.error ?? (status.state === "expired" ? "GitHub login expired." : status.state === "cancelled" ? null : "GitHub login failed."));
		}
	}

	function fail(a: Attempt, err: unknown) {
		if (a.terminal || !mounted.current || attempt.current !== a) return;
		if (a.cancelled && a.id) return; // The outstanding DELETE owns reconciliation.
		setError(err instanceof Error ? err.message : "GitHub login failed. Check your connection and retry.");
		if (a.id) {
			setRetry("cancel");
			setBusy(true);
			stop(a);
		} else {
			a.terminal = true;
			setRetry("login");
			setBusy(false);
		}
	}

	async function poll(a: Attempt) {
		if (a.cancelled || a.terminal) return;
		try {
			await receive(a, await request<CopilotLoginStatus>(`${AUTH}/login/${encodeURIComponent(a.id!)}`));
		} catch (err) { fail(a, err); }
	}

	async function connect() {
		if (busy) return;
		if (attempt.current) stop(attempt.current);
		const a: Attempt = { cancelled: false, terminal: false, cancelSent: false };
		attempt.current = a;
		setBusy(true);
		setLogin(null);
		setError(null);
		setCopied(false);
		setRetry("login");
		try {
			await receive(a, await request<CopilotLoginStatus>(`${AUTH}/login`, {
				method: "POST", headers: { "content-type": "application/json" }, body: "{}",
			}));
		} catch (err) { fail(a, err); }
	}

	function cancel() {
		setBusy(true);
		setRetry("cancel");
		setError(null);
		if (attempt.current) stop(attempt.current);
	}

	async function disconnect() {
		setBusy(true);
		setError(null);
		setRetry("disconnect");
		try {
			await request<CopilotStatus>(AUTH, { method: "DELETE" });
			if (mounted.current) { setConnected(false); setLogin(null); }
			notifySettingsSaved("keys");
		} catch (err) {
			if (mounted.current) setError(err instanceof Error ? err.message : "Could not disconnect.");
		} finally {
			if (mounted.current) setBusy(false);
		}
	}

	const waiting = busy && retry === "login";
	const canRetry = !busy && (error !== null || (login !== null && !pending(login) && login.state !== "connected"));
	// Only github.com is supported. Never navigate to an arbitrary server-supplied host.
	let verificationUri: string | null = null;
	try {
		const uri = new URL(login?.verificationUri ?? "");
		if (uri.protocol === "https:" && uri.hostname === "github.com" && !uri.username && !uri.password && !uri.port) verificationUri = uri.href;
	} catch { /* No verification URL until the device code arrives. */ }

	return (
		<div className="flex flex-col gap-2 px-1 py-1.5" data-testid="copilot-connection">
			<div className="flex items-center justify-between gap-3">
				<span className="font-ui text-xs text-foreground">GitHub Copilot</span>
				{connected ? (
					<div className="flex items-center gap-2">
						<span className="text-xs text-muted-foreground" role="status">Connected</span>
						<button type="button" className={buttonClass} onClick={() => void disconnect()} disabled={busy}>Disconnect</button>
					</div>
				) : !waiting && !canRetry ? (
					<button type="button" className={buttonClass} onClick={() => void connect()} disabled={busy || connected === null}>
						{busy ? "Loading…" : setup ? "Connect GitHub Copilot" : "Connect"}
					</button>
				) : null}
			</div>
			{!connected && <p className="text-xs text-muted-foreground">Connecting may enable eligible models on your GitHub account.</p>}
			<p className="text-xs text-muted-foreground">GitHub tracks Copilot subscription usage; dollar costs are unavailable.</p>
			{connected && <p className="text-xs text-muted-foreground">Disconnect removes this app’s local credentials only. It does not revoke access on GitHub.</p>}
			{busy && retry === "cancel" && <p role="status" className="text-xs text-muted-foreground">Cancelling GitHub login…</p>}
			{waiting && (
				<div className="flex flex-col gap-2">
					<p role="status" className="text-xs text-muted-foreground">{login?.state === "waiting" ? "Waiting for GitHub authorization…" : "Starting GitHub login…"}</p>
					{login?.userCode && <div className="flex items-center gap-2">
						<code className="select-all font-mono text-sm" data-testid="copilot-code">{login.userCode}</code>
						<button type="button" className={buttonClass} onClick={async () => {
							try { await navigator.clipboard.writeText(login.userCode!); if (mounted.current) { setCopied(true); setError(null); } }
							catch { if (mounted.current) setError("Could not copy. Select and copy the code manually."); }
						}}>{copied ? "Copied" : "Copy"}</button>
					</div>}
					<div className="flex items-center gap-2">
						{verificationUri && <a href={verificationUri} target="_blank" rel="noopener noreferrer" className={buttonClass}>Open GitHub ↗</a>}
						<button type="button" className={buttonClass} onClick={cancel}>Cancel</button>
					</div>
				</div>
			)}
			{error && <p role="alert" className="text-xs text-red-400">{error}</p>}
			{canRetry && <button type="button" className={`${buttonClass} self-start`} onClick={() => void (retry === "status" ? loadStatus() : retry === "disconnect" ? disconnect() : retry === "cancel" ? reconcileCancellation() : connect())}>Retry</button>}
		</div>
	);
}
