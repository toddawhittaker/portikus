/**
 * One Preview tab (SPEC.md §14.6, §14.8, BROWSER-HANDLING.md §12).
 *
 * The frame is pointed at a bootstrap URL the API mints; that URL sets the
 * preview session cookie on the preview host and redirects to `/`, so the
 * student's application is what the frame ends up showing. Nothing about
 * the application is rewritten, stripped or proxied here.
 */
import { EmptyState, IconButton, useToast } from "@portikus/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../api/request.js";
import { useListening } from "../running/services.js";
import { type Grant, requestGrant, resetPreviewData } from "./grants.js";
import "./preview.css";

/**
 * How long the frame has to report that it loaded before the tab assumes
 * the application refused to be embedded. The browser gives no event for an
 * `X-Frame-Options` or `frame-ancestors` refusal, so a frame that never
 * loads while the port is listening is the only signal there is; a very slow
 * application can therefore be reported as blocked, and Reload puts it right.
 */
const LOAD_TIMEOUT_MS = 8_000;

/** The viewport widths the toolbar offers (BROWSER-HANDLING.md §12). */
const WIDTHS = ["fit", "375", "768", "1024", "1440"] as const;
type Width = (typeof WIDTHS)[number];

type State =
	| { status: "connecting" }
	| { status: "available"; grant: Grant }
	| { status: "inactive" }
	| { status: "unauthorized" }
	| { status: "blocked"; grant: Grant }
	| { status: "error"; message: string };

export interface PreviewLeafProps {
	workspaceId: string;
	port: number;
	visible: boolean;
	/** Bring the Running surface into view (BROWSER-HANDLING.md §12). */
	onShowRunning: () => void;
}

export function PreviewLeaf({
	workspaceId,
	port,
	visible,
	onShowRunning,
}: PreviewLeafProps) {
	const toast = useToast();
	const listening = useListening();
	const [state, setState] = useState<State>({ status: "connecting" });
	const [width, setWidth] = useState<Width>("fit");
	const frame = useRef<HTMLIFrameElement | null>(null);
	const loadTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

	/** Whether the API says something is listening on this port. */
	const isListening = listening.services.some((service) => service.port === port);

	const connect = useCallback(async () => {
		if (loadTimer.current !== undefined) clearTimeout(loadTimer.current);
		setState({ status: "connecting" });
		try {
			const grant = await requestGrant(workspaceId, port, "embedded");
			setState({ status: "available", grant });
		} catch (error) {
			if (error instanceof ApiError && error.status === 403) {
				setState({ status: "unauthorized" });
				return;
			}
			setState({
				status: "error",
				message:
					error instanceof ApiError
						? error.message
						: "Something went wrong. Please try again.",
			});
		}
	}, [workspaceId, port]);

	// Ask for a grant when the tab opens, and again when the port starts
	// listening after it was not (SPEC.md §14.8).
	// Until the first list is in, the tab says it is connecting rather than
	// guessing: a saved preview must not ask for a grant for a port that
	// stopped listening while the workspace was away (SPEC.md §14.8).
	useEffect(() => {
		if (!listening.loaded) return;
		if (!isListening) {
			setState({ status: "inactive" });
			return;
		}
		void connect();
	}, [listening.loaded, isListening, connect]);

	// A frame that never loads while the port is listening is taken to have
	// been refused embedding; see LOAD_TIMEOUT_MS.
	useEffect(() => {
		if (state.status !== "available") return;
		const grant = state.grant;
		loadTimer.current = setTimeout(() => {
			setState({ status: "blocked", grant });
		}, LOAD_TIMEOUT_MS);
		return () => clearTimeout(loadTimer.current);
	}, [state]);

	function onFrameLoad() {
		if (loadTimer.current !== undefined) clearTimeout(loadTimer.current);
	}

	function onFrameError() {
		if (state.status === "available") {
			setState({ status: "blocked", grant: state.grant });
		}
	}

	/**
	 * Open the preview as a browser tab. The grant is asked for first and the
	 * window opened from the same click, because a popup blocker only allows
	 * a window a user gesture opened.
	 */
	async function openInNewTab() {
		const opened = window.open("", "_blank", "noopener,noreferrer");
		try {
			const grant = await requestGrant(workspaceId, port, "top-level");
			if (opened) opened.location.href = grant.bootstrapUrl;
			else window.open(grant.bootstrapUrl, "_blank", "noopener,noreferrer");
		} catch {
			opened?.close();
			toast.show({
				tone: "danger",
				title: "That preview could not be opened",
				children: "Check that your application is still running, then try again.",
			});
		}
	}

	async function copyUrl() {
		const origin =
			state.status === "available" || state.status === "blocked"
				? state.grant.previewOrigin
				: null;
		if (!origin) return;
		try {
			await navigator.clipboard.writeText(origin);
			toast.show({
				tone: "neutral",
				title: "Preview link copied",
				children: "This link only works while you are signed in.",
			});
		} catch {
			toast.show({ tone: "danger", title: "That link could not be copied" });
		}
	}

	async function resetData() {
		try {
			await resetPreviewData(workspaceId);
		} catch {
			toast.show({ tone: "danger", title: "The preview data could not be reset" });
			return;
		}
		toast.show({ tone: "success", title: "Preview data reset" });
		void connect();
	}

	const host =
		state.status === "available" || state.status === "blocked"
			? new URL(state.grant.previewOrigin).host
			: `port ${port}`;

	return (
		<div
			className="pk-preview"
			data-testid={`preview-pane-${port}`}
			data-state={state.status}
			hidden={!visible}
		>
			<div className="pk-preview-bar">
				<span className="pk-preview-host" data-testid="preview-host" title={host}>
					{host}
				</span>
				<IconButton
					icon="restart"
					label="Reload preview"
					size="sm"
					data-testid="preview-reload"
					onClick={() => void connect()}
				/>
				<IconButton
					icon="external"
					label="Open preview in a new tab"
					size="sm"
					data-testid="preview-new-tab"
					onClick={() => void openInNewTab()}
				/>
				<button
					type="button"
					className="pk-preview-action"
					data-testid="preview-copy"
					onClick={() => void copyUrl()}
				>
					Copy URL
				</button>
				<label className="pk-preview-width" htmlFor={`preview-width-${port}`}>
					Width
					<select
						id={`preview-width-${port}`}
						data-testid="preview-width"
						value={width}
						onChange={(event) => setWidth(event.target.value as Width)}
					>
						{WIDTHS.map((option) => (
							<option key={option} value={option}>
								{option === "fit" ? "Fit" : `${option} px`}
							</option>
						))}
					</select>
				</label>
				<button
					type="button"
					className="pk-preview-action"
					data-testid="preview-reset"
					onClick={() => void resetData()}
				>
					Reset preview data
				</button>
				<button
					type="button"
					className="pk-preview-action"
					data-testid="preview-running-link"
					onClick={onShowRunning}
				>
					Running
				</button>
			</div>

			<div className="pk-preview-body">
				{state.status === "connecting" ? (
					<p className="pk-preview-note" data-testid="preview-connecting">
						Connecting to port {port}…
					</p>
				) : null}

				{state.status === "inactive" ? (
					<EmptyState
						icon="preview"
						title={`Nothing is running on port ${port}`}
						actions={
							<button
								type="button"
								className="pk-preview-action"
								data-testid="preview-retry"
								onClick={() => void connect()}
							>
								Retry
							</button>
						}
					>
						<span data-testid="preview-inactive">
							Nothing is currently listening on port {port}. Start your application to
							reconnect this preview.
						</span>
					</EmptyState>
				) : null}

				{state.status === "unauthorized" ? (
					<EmptyState icon="lock" title="You cannot preview this workspace">
						<span data-testid="preview-unauthorized">
							Ask your instructor if you think you should have access.
						</span>
					</EmptyState>
				) : null}

				{state.status === "error" ? (
					<EmptyState
						icon="alert"
						title="That preview did not open"
						actions={
							<button
								type="button"
								className="pk-preview-action"
								data-testid="preview-retry"
								onClick={() => void connect()}
							>
								Try again
							</button>
						}
					>
						<span data-testid="preview-error">{state.message}</span>
					</EmptyState>
				) : null}

				{state.status === "blocked" ? (
					<EmptyState
						icon="alert"
						title="This application cannot be embedded"
						actions={
							<button
								type="button"
								className="pk-preview-action"
								data-testid="preview-blocked-new-tab"
								onClick={() => void openInNewTab()}
							>
								Open in new tab
							</button>
						}
					>
						<span data-testid="preview-blocked">
							Your application asks browsers not to show it inside another page. Open it
							in a new tab instead.
						</span>
					</EmptyState>
				) : null}

				{state.status === "available" ? (
					<iframe
						ref={frame}
						key={state.grant.bootstrapUrl}
						className="pk-preview-frame"
						data-testid="preview-frame"
						title={`Preview of port ${port}`}
						src={state.grant.bootstrapUrl}
						style={width === "fit" ? undefined : { maxWidth: `${width}px` }}
						onLoad={onFrameLoad}
						onError={onFrameError}
						sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-downloads allow-pointer-lock"
						referrerPolicy="no-referrer"
						allow="clipboard-read 'none'; clipboard-write 'self'; camera 'none'; microphone 'none'; geolocation 'none'"
					/>
				) : null}
			</div>
		</div>
	);
}
