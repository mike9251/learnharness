/** Server-only OAuth credentials. Deliberately separate from the API-key auth.json.
 * Reads are fresh; mutations hold a filesystem lock across the entire async
 * refresh callback, including across store instances, HMR and Node processes.
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type {
	AuthOperationOptions,
	Credential,
	CredentialStore,
	OAuthCredential,
} from "@earendil-works/pi-ai";
import { OAUTH_FILE } from "../../config.ts";

export interface OAuthStore extends CredentialStore {
	/** Synchronous presence/catalog access; never returns a cached/shared object. */
	readCredential(providerId: string): OAuthCredential | undefined;
}

type CredentialMap = Record<string, OAuthCredential>;
const LOCK_WAIT_MS = 30_000;
const LOCK_RETRY_MS = 25;

function isMissing(error: unknown): boolean {
	return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

function validateCredential(value: unknown): asserts value is OAuthCredential {
	if (
		!value || typeof value !== "object" || Array.isArray(value) ||
		!("type" in value) || value.type !== "oauth" ||
		!("access" in value) || typeof value.access !== "string" ||
		!("refresh" in value) || typeof value.refresh !== "string" ||
		!("expires" in value) || typeof value.expires !== "number" || !Number.isFinite(value.expires)
	) {
		// Never include raw values or JSON parser messages: they can contain tokens.
		throw new Error("Invalid OAuth credential data");
	}
}

function validateMap(value: unknown): asserts value is CredentialMap {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Invalid OAuth credential file");
	}
	for (const credential of Object.values(value)) validateCredential(credential);
}

function readMap(filePath: string): CredentialMap {
	let text: string;
	try {
		// A dangling symlink is a storage failure, not an empty store. Also avoid
		// replacing symlink targets unexpectedly during the atomic rename.
		if (!fs.lstatSync(filePath).isFile()) throw new Error("OAuth credential path must be a regular file");
		text = fs.readFileSync(filePath, "utf8");
	} catch (error) {
		if (isMissing(error)) return {};
		throw error;
	}
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new Error("Invalid OAuth credential JSON");
	}
	validateMap(value);
	return value;
}

function entry(map: CredentialMap, providerId: string): OAuthCredential | undefined {
	return Object.hasOwn(map, providerId) ? map[providerId] : undefined;
}

/** Atomic replacement: exclusive temp creation, 0600 BEFORE rename, and cleanup
 * on failure. No await between the last cancellation check and commit. */
function writeMap(filePath: string, map: CredentialMap, signal?: AbortSignal): void {
	let text: string;
	try {
		text = `${JSON.stringify(map, null, "\t")}\n`;
	} catch {
		throw new Error("OAuth credential metadata must be JSON serializable");
	}
	// Validate the actual representation too (e.g. custom toJSON methods).
	validateMap(JSON.parse(text));
	signal?.throwIfAborted();
	const temp = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
	let fd: number | undefined;
	try {
		fd = fs.openSync(temp, "wx", 0o600);
		fs.fchmodSync(fd, 0o600);
		fs.writeFileSync(fd, text, "utf8");
		fs.fsyncSync(fd);
		fs.closeSync(fd);
		fd = undefined;
		signal?.throwIfAborted();
		fs.renameSync(temp, filePath);
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
		try { fs.unlinkSync(temp); } catch (error) { if (!isMissing(error)) throw error; }
	}
}

/** Never reclaim a lock based on age: an OAuth network request can outlive any
 * stale threshold. Orphan/unknown locks fail closed after a bounded wait; an
 * operator may remove <oauth file>.lock only after confirming all writers have
 * stopped. This deliberately favors token safety over automatic crash recovery.
 */
async function withLock<T>(filePath: string, options: AuthOperationOptions | undefined, fn: () => Promise<T>): Promise<T> {
	const signal = options?.signal;
	signal?.throwIfAborted();
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	const lock = `${filePath}.lock`;
	const deadline = Date.now() + LOCK_WAIT_MS;
	for (;;) {
		signal?.throwIfAborted();
		try {
			fs.mkdirSync(lock, { mode: 0o700 });
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
			if (Date.now() >= deadline) throw new Error("Timed out waiting for OAuth credential lock; no data was changed");
			await delay(LOCK_RETRY_MS, undefined, { signal });
		}
	}
	try {
		signal?.throwIfAborted();
		return await fn();
	} finally {
		fs.rmdirSync(lock);
	}
}

export function createOAuthStore(filePath: string): OAuthStore {
	// No IO at construction: importing the singleton never touches credentials.
	const file = path.resolve(filePath);
	return {
		readCredential(providerId) {
			return entry(readMap(file), providerId);
		},
		async read(providerId, options) {
			options?.signal?.throwIfAborted();
			return entry(readMap(file), providerId);
		},
		async list(options) {
			options?.signal?.throwIfAborted();
			return Object.keys(readMap(file)).map((providerId) => ({ providerId, type: "oauth" as const }));
		},
		async modify(providerId, fn, options) {
			return withLock(file, options, async () => {
				const map = readMap(file);
				const current = entry(map, providerId);
				// Callback mutation followed by undefined must leave the entry unchanged.
				const next: Credential | undefined = await fn(current === undefined ? undefined : structuredClone(current));
				options?.signal?.throwIfAborted();
				if (next === undefined) return current;
				validateCredential(next);
				// A hand-edit/non-cooperating writer during a network refresh must
				// not be silently overwritten, especially if it corrupted the file.
				if (JSON.stringify(readMap(file)) !== JSON.stringify(map)) {
					throw new Error("OAuth credential file changed during modification; no data was changed");
				}
				writeMap(file, { ...map, [providerId]: next }, options?.signal);
				return entry(readMap(file), providerId);
			});
		},
		async delete(providerId, options) {
			await withLock(file, options, async () => {
				const map = readMap(file);
				if (!Object.hasOwn(map, providerId)) return;
				delete map[providerId];
				writeMap(file, map, options?.signal);
			});
		},
	};
}

export const oauthStore = createOAuthStore(OAUTH_FILE);
