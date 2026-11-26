/**
 * Clone, duplicate and restore answer 202 at once and finish on the server,
 * so no request outlasts a proxy's response timeout (SPEC.md §7.2, §7.3,
 * §15.8). These helpers follow an operation to its end and answer as the
 * request used to: the new project, nothing for a restore, or the same error.
 */
import {
	CurrentProjectOperation,
	Project,
	ProjectOperation,
} from "@portikus/contracts";
import { useCallback, useEffect, useRef } from "react";
import { ApiError, request, toApiError } from "../api/request.js";

/** How often a running operation is read again. */
const OPERATION_POLL_MS = 1000;
/** The longest wait between checks while the server cannot be reached. */
const RETRY_MAX_MS = 8000;
/**
 * How long checks may keep failing before the page gives up. A proxy's 502
 * or a dropped connection says nothing about the operation itself.
 */
export const RETRY_FOR_MS = 30_000;

/** Shown when the server no longer knows the operation, as after a restart. */
export const LOST_OPERATION_MESSAGE =
	"Portikus lost track of this request, which can happen when the server restarts. Check the projects list to see whether it finished, then try again if it did not.";

/** Shown when the server could not be asked how the operation went. */
export const UNREACHABLE_MESSAGE =
	"Portikus could not check on this request. It may still finish; reload the page to see how it went.";

const UNREACHABLE = "OPERATION_UNREACHABLE";

/** True when checks kept failing, so the outcome is still unknown. */
const isUnreachable = (error: unknown) =>
	error instanceof ApiError && error.code === UNREACHABLE;

const operationUrl = (workspaceId: string) =>
	`/workspaces/${workspaceId}/project-operation`;

/** The workspace's current or most recent operation, or null. */
export async function readOperation(
	workspaceId: string,
	signal?: AbortSignal,
): Promise<ProjectOperation | null> {
	const body = await request(CurrentProjectOperation, operationUrl(workspaceId), {
		signal,
	});
	return body.operation;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(signal.reason);
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", stop);
			resolve();
		}, ms);
		const stop = () => {
			clearTimeout(timer);
			reject(signal?.reason);
		};
		signal?.addEventListener("abort", stop, { once: true });
	});
}

/**
 * Wait for `operation` to finish; a failure throws the error the request used
 * to. A check that fails is tried again, backing off, for RETRY_FOR_MS.
 * Aborting `signal` stops the checks and rejects with its reason.
 */
export async function followOperation(
	workspaceId: string,
	operation: ProjectOperation,
	signal?: AbortSignal,
): Promise<ProjectOperation> {
	let current = operation;
	let delay = OPERATION_POLL_MS;
	let failingSince: number | null = null;
	while (current.state === "running") {
		await sleep(delay, signal);
		let read: ProjectOperation | null;
		try {
			read = await readOperation(workspaceId, signal);
		} catch {
			if (signal?.aborted) throw signal.reason;
			failingSince ??= Date.now();
			if (Date.now() - failingSince >= RETRY_FOR_MS) {
				throw new ApiError(503, UNREACHABLE_MESSAGE, UNREACHABLE);
			}
			delay = Math.min(delay * 2, RETRY_MAX_MS);
			continue;
		}
		failingSince = null;
		delay = OPERATION_POLL_MS;
		if (read?.id !== operation.id) throw new ApiError(410, LOST_OPERATION_MESSAGE);
		current = read;
	}
	if (current.error) {
		throw new ApiError(current.error.status, current.error.message, current.error.code);
	}
	return current;
}

/** What a POST to a slow project route answered: an operation, or the answer itself. */
export type Sent =
	| { kind: "started"; operation: ProjectOperation }
	| { kind: "answered"; status: number; body: unknown };

/** POST `body` to `url`; a refusal throws the API's error. */
export async function sendOperation(url: string, body: unknown): Promise<Sent> {
	const response = await fetch(url, {
		method: "POST",
		credentials: "same-origin",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!response.ok) throw await toApiError(response);
	if (response.status === 202) {
		const operation = ProjectOperation.parse(await response.json());
		markOperationStarted(operation.id);
		return { kind: "started", operation };
	}
	const answer = response.status === 204 ? undefined : await response.json();
	return { kind: "answered", status: response.status, body: answer };
}

/**
 * Follow `operation`, then mark it shown by this page so a reload does not
 * repeat it. An abort or an unknown outcome leaves it unmarked, so whoever
 * follows it next still shows how it went.
 */
export async function followHere(
	workspaceId: string,
	operation: ProjectOperation,
	signal?: AbortSignal,
): Promise<ProjectOperation> {
	try {
		const done = await followOperation(workspaceId, operation, signal);
		markOperationHandled(operation.id);
		return done;
	} catch (error) {
		if (!signal?.aborted && !isUnreachable(error)) markOperationHandled(operation.id);
		throw error;
	}
}

/** How a caller follows an operation it starts: a cancel signal and a hook for the start. */
export type Following = {
	signal?: AbortSignal;
	onStarted?: (operation: ProjectOperation) => void;
};

/**
 * POST `body` to `url` and follow the operation a 202 starts. A route that
 * answered at once (a new empty project) is read as before.
 */
export async function postOperation(
	workspaceId: string,
	url: string,
	body: unknown,
	following: Following = {},
): Promise<Project | undefined> {
	const sent = await sendOperation(url, body);
	if (sent.kind === "answered") {
		return sent.body === undefined ? undefined : Project.parse(sent.body);
	}
	following.onStarted?.(sent.operation);
	const done = await followHere(workspaceId, sent.operation, following.signal);
	return done.project ?? undefined;
}

type HandOff = (workspaceId: string, operation: ProjectOperation) => void;
const handOffListeners = new Set<HandOff>();

/** Listen for operations a closed dialog left running; returns the unsubscribe. */
export function onOperationHandOff(listener: HandOff): () => void {
	handOffListeners.add(listener);
	return () => handOffListeners.delete(listener);
}

/**
 * For a mutation a dialog runs: gives each run a cancel signal, and when the
 * dialog closes while its operation still runs, stops following it there and
 * hands it to the page, which announces the outcome instead.
 */
export function useHandOffOnClose(workspaceId: string): () => Following & {
	finish: () => void;
} {
	const live = useRef<{
		controller: AbortController;
		operation: ProjectOperation | null;
	} | null>(null);
	useEffect(
		() => () => {
			const current = live.current;
			live.current = null;
			if (!current) return;
			current.controller.abort();
			if (!current.operation) return;
			for (const listener of handOffListeners) listener(workspaceId, current.operation);
		},
		[workspaceId],
	);
	return useCallback(() => {
		const entry = {
			controller: new AbortController(),
			operation: null as ProjectOperation | null,
		};
		live.current = entry;
		return {
			signal: entry.controller.signal,
			onStarted: (operation: ProjectOperation) => {
				entry.operation = operation;
			},
			finish: () => {
				if (live.current === entry) live.current = null;
			},
		};
	}, []);
}

const HANDLED_KEY = "portikus.handled-project-operation";
const STARTED_KEY = "portikus.started-project-operation";

function store(key: string, id: string): void {
	try {
		sessionStorage.setItem(key, id);
	} catch {
		// Without storage a reload may show the outcome once more, or not at all; nothing breaks.
	}
}

function stored(key: string, id: string): boolean {
	try {
		return sessionStorage.getItem(key) === id;
	} catch {
		return false;
	}
}

/** Remember that this tab has shown `id`'s outcome, so a reload does not show it twice. */
export const markOperationHandled = (id: string) => store(HANDLED_KEY, id);
export const isOperationHandled = (id: string) => stored(HANDLED_KEY, id);

/** Remember that this tab started `id`: only its own finished operations are replayed. */
export const markOperationStarted = (id: string) => store(STARTED_KEY, id);
export const isOperationStartedHere = (id: string) => stored(STARTED_KEY, id);
