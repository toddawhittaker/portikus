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
import {
	clearPreviewOriginData,
	type Grant,
	probeEmbeddable,
	requestGrant,
	resetPreviewData,
} from "./grants.js";
import { stepJointHistory } from "./history.js";
import "./preview.css";

/**
 * How long the frame has to report that it loaded before the tab assumes
 * the application refused to be embedded. This is the fallback: the control
 * plane's framing probe is what normally catches a refusal, and this catches
 * a frame that goes nowhere for some other reason. Because a very slow
 * application (a first `next dev` compile) can be guessed wrong, the frame
 * stays mounted behind the notice and a late load clears it.
 */
const LOAD_TIMEOUT_MS = 8_000;

/**
 * How long a listening port may be missing from the list before an open
 * preview gives up on it. The registry reports an empty list for up to two
 * seconds after the API restarts, and that must not reload a running
 * application (SPEC.md §14.8).
 */
const LISTENING_GRACE_MS = 3_000;

/** The viewport widths the toolbar offers (BROWSER-HANDLING.md §12). */
const WIDTHS = ["fit", "375", "768", "1024", "1440"] as const;
type Width = (typeof WIDTHS)[number];

type State =
	| { status: "connecting" }
	| { status: "available"; grant: Grant }
	| { status: "inactive" }
	| { status: "unauthorized" }
	/**
	 * `probed` is true when the control plane asked the application and it
	 * refused framing. A load event must not clear that: the browser fires one
	 * for a refused navigation too.
	 */
	| { status: "blocked"; grant: Grant; probed: boolean }
	/**
	 * The application answered, but its development server refuses the
	 * preview host and says which setting would allow it (issue #262).
	 */
	| {
			status: "host-refused";
			grant: Grant;
			refusedHost: string;
			server: RefusedServer;
	  }
	| { status: "error"; message: string };

/** The development servers whose refusal the control plane recognises. */
type RefusedServer = "vite" | "webpack-dev-server";

/** What each server calls the setting, and where it lives. */
const ALLOWED_HOSTS_SETTING: Record<
	RefusedServer,
	{ name: string; file: string; line: (suffix: string) => string }
> = {
	vite: {
		name: "Vite",
		file: "vite.config.js",
		line: (suffix) => `server: { allowedHosts: ["${suffix}"] }`,
	},
	"webpack-dev-server": {
		name: "webpack-dev-server",
		file: "webpack.config.js",
		line: (suffix) => `devServer: { allowedHosts: ["${suffix}"] }`,
	},
};

/** The grant a state is showing, if it has one. */
function grantOf(state: State): Grant | null {
	switch (state.status) {
		case "available":
		case "blocked":
		case "host-refused":
			return state.grant;
		default:
			return null;
	}
}

/**
 * The preview suffix as an allow-list entry: the refused host without its
 * workspace label, so one line covers every port and every project.
 */
function suffixOf(refusedHost: string): string {
	const dot = refusedHost.indexOf(".");
	return dot === -1 ? refusedHost : refusedHost.slice(dot);
}

/** The one line that lets this server accept every preview host. */
function allowedHostsLine(server: RefusedServer, refusedHost: string): string {
	return ALLOWED_HOSTS_SETTING[server].line(suffixOf(refusedHost));
}

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
	/** The bootstrap URL of the frame that has reported a load, if any. */
	const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
	const frame = useRef<HTMLIFrameElement | null>(null);
	const statusRef = useRef<State["status"]>("connecting");

	/** Whether the API says something is listening on this port. */
	const isListening = listening.services.some((service) => service.port === port);

	const connect = useCallback(async () => {
		setState({ status: "connecting" });
		try {
			const grant = await requestGrant(workspaceId, port, "embedded");
			setState({ status: "available", grant });
			// Ask whether the application allows framing. The browser gives the
			// parent page no way to see a refusal for itself: Chromium fires the
			// frame's load event even for a navigation it refused, which is why
			// the timeout below cannot be the only signal.
			let verdict: Awaited<ReturnType<typeof probeEmbeddable>>;
			try {
				verdict = await probeEmbeddable(workspaceId, port);
			} catch {
				// A failed probe is not a refusal; the timeout still applies.
				return;
			}
			// An application that did not answer may simply be starting up, so
			// only a real refusal short-circuits the timeout.
			if (verdict.embeddable || verdict.reason === "unreachable") return;
			// A development server that refuses the preview host is a
			// different problem, with a setting the student can fix.
			const refused =
				verdict.reason === "host-refused" &&
				verdict.refusedHost &&
				verdict.refusedServer
					? { host: verdict.refusedHost, server: verdict.refusedServer }
					: null;
			// The grant this probe was made for must still be the one on
			// screen; a later connect replaced it otherwise.
			setState((current) => {
				if (current.status !== "available" || current.grant !== grant) return current;
				if (refused) {
					return {
						status: "host-refused",
						grant,
						refusedHost: refused.host,
						server: refused.server,
					};
				}
				return { status: "blocked", grant, probed: true };
			});
		} catch (error) {
			// A refused port is about the port, not about the student, so it
			// keeps the API's sentence instead of the sign-in wording.
			if (
				error instanceof ApiError &&
				error.status === 403 &&
				error.code !== "PREVIEW_PORT_NOT_ALLOWED"
			) {
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

	// The reconnect effect below reads the status without depending on it, so
	// that a change in the listening list is the only thing that can run it.
	useEffect(() => {
		statusRef.current = state.status;
	}, [state.status]);

	// Ask for a grant when the tab opens, and again when the port starts
	// listening after it was not (SPEC.md §14.8).
	// Until the first list is in, the tab says it is connecting rather than
	// guessing: a saved preview must not ask for a grant for a port that
	// stopped listening while the workspace was away (SPEC.md §14.8).
	useEffect(() => {
		if (!listening.loaded) return;
		const showing =
			statusRef.current === "available" ||
			statusRef.current === "blocked" ||
			statusRef.current === "host-refused";
		if (isListening) {
			// An open preview is already pointed at this port; re-granting here
			// would reload the application for nothing.
			if (showing || statusRef.current === "unauthorized") return;
			void connect();
			return;
		}
		if (!showing) {
			setState({ status: "inactive" });
			return;
		}
		const timer = setTimeout(
			() => setState({ status: "inactive" }),
			LISTENING_GRACE_MS,
		);
		return () => clearTimeout(timer);
	}, [listening.loaded, isListening, connect]);

	// A frame that never loads while the port is listening is taken to have
	// been refused embedding; see LOAD_TIMEOUT_MS. The guess is not made twice
	// for a frame that has already reported a load.
	useEffect(() => {
		if (state.status !== "available") return;
		const grant = state.grant;
		if (loadedUrl === grant.bootstrapUrl) return;
		const timer = setTimeout(() => {
			setState({ status: "blocked", grant, probed: false });
		}, LOAD_TIMEOUT_MS);
		return () => clearTimeout(timer);
	}, [state, loadedUrl]);

	function onFrameLoad() {
		if (state.status !== "available" && state.status !== "blocked") return;
		setLoadedUrl(state.grant.bootstrapUrl);
		// A slow application that finally loaded was not refusing to be
		// embedded after all. An application the control plane asked directly
		// is another matter: the browser fires this event for the refused
		// navigation as well, so that verdict stands.
		if (state.status === "blocked" && !state.probed)
			setState({ status: "available", grant: state.grant });
	}

	function onFrameError() {
		if (state.status === "available") {
			setState({ status: "blocked", grant: state.grant, probed: false });
		}
	}

	/**
	 * Open the preview as a browser tab. The blank tab is opened from the
	 * click itself, because a popup blocker only allows a window a user
	 * gesture opened, and the grant arrives too late for that. No window
	 * feature is asked for: both `noopener` and `noreferrer` (which implies
	 * `noopener`) make Chromium return null, which orphans the blank tab and
	 * leaves the student with two tabs once the grant arrives. Clearing
	 * `opener` on the handle cuts the back-reference instead.
	 */
	async function openInNewTab() {
		const opened = window.open("about:blank", "_blank");
		if (opened) opened.opener = null;
		try {
			const grant = await requestGrant(workspaceId, port, "top-level");
			if (opened) opened.location.replace(grant.bootstrapUrl);
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

	/** Copy the allow-list line, so the student can paste it into the config. */
	async function copyAllowedHosts() {
		if (state.status !== "host-refused") return;
		try {
			await navigator.clipboard.writeText(
				allowedHostsLine(state.server, state.refusedHost),
			);
			toast.show({ tone: "neutral", title: "Setting copied" });
		} catch {
			toast.show({ tone: "danger", title: "That setting could not be copied" });
		}
	}

	async function copyUrl() {
		const origin = grantOf(state)?.previewOrigin ?? null;
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

	/**
	 * Reset in three steps (BROWSER-HANDLING.md §16.4): revoke the workspace's
	 * preview sessions, ask the preview origin to clear the browser data it
	 * holds, then take a fresh grant and re-bootstrap the frame.
	 */
	async function resetData() {
		const origin = grantOf(state)?.previewOrigin ?? null;
		try {
			await resetPreviewData(workspaceId);
			if (origin) await clearPreviewOriginData(origin);
		} catch {
			toast.show({ tone: "danger", title: "The preview data could not be reset" });
			return;
		}
		toast.show({ tone: "success", title: "Preview data reset" });
		void connect();
	}

	const showingGrant = grantOf(state);
	const host = showingGrant ? new URL(showingGrant.previewOrigin).host : `port ${port}`;

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
				{/* Always enabled: the frame is cross-origin, so whether it has
				    somewhere to go back to cannot be read (issue #271). */}
				<button
					type="button"
					className="pk-preview-action"
					data-testid="preview-back"
					onClick={() => void stepJointHistory("back", window)}
				>
					Back
				</button>
				<button
					type="button"
					className="pk-preview-action"
					data-testid="preview-forward"
					onClick={() => void stepJointHistory("forward", window)}
				>
					Forward
				</button>
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
				{/* Every state but the frame itself is one compact stack, centred
				    in the pane rather than spread down it (issue #275). */}
				{state.status === "connecting" ? (
					<div className="pk-preview-state">
						<p className="pk-preview-note" data-testid="preview-connecting">
							Connecting to port {port}…
						</p>
					</div>
				) : null}

				{state.status === "inactive" ? (
					<div className="pk-preview-state">
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
					</div>
				) : null}

				{state.status === "unauthorized" ? (
					<div className="pk-preview-state">
						<EmptyState icon="lock" title="You cannot preview this workspace">
							<span data-testid="preview-unauthorized">
								Ask your instructor if you think you should have access.
							</span>
						</EmptyState>
					</div>
				) : null}

				{state.status === "error" ? (
					<div className="pk-preview-state">
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
					</div>
				) : null}

				{/* The development server answered, but it refuses the preview
				    host. The student can allow it in one line (issue #262). */}
				{state.status === "host-refused" ? (
					<div className="pk-preview-state">
						<EmptyState
							icon="alert"
							title="Your dev server is refusing the preview host"
							actions={
								<>
									<button
										type="button"
										className="pk-preview-action"
										data-testid="preview-refused-copy"
										onClick={() => void copyAllowedHosts()}
									>
										Copy
									</button>
									<button
										type="button"
										className="pk-preview-action"
										data-testid="preview-retry"
										onClick={() => void connect()}
									>
										Retry
									</button>
								</>
							}
						>
							<span data-testid="preview-refused">
								{ALLOWED_HOSTS_SETTING[state.server].name} turned away{" "}
								{state.refusedHost} because that host is not in its allow-list. Add this
								line to {ALLOWED_HOSTS_SETTING[state.server].file}, restart the server,
								then retry.
							</span>
							<code className="pk-preview-config" data-testid="preview-refused-line">
								{allowedHostsLine(state.server, state.refusedHost)}
							</code>
						</EmptyState>
					</div>
				) : null}

				{/* An overlay, not a replacement: the frame underneath keeps the
				    load it started, so a slow application can still arrive. */}
				{state.status === "blocked" ? (
					<div className="pk-preview-overlay">
						<div className="pk-preview-state">
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
									Your application asks browsers not to show it inside another page.
									Open it in a new tab instead.
								</span>
							</EmptyState>
						</div>
					</div>
				) : null}

				{state.status === "available" || state.status === "blocked" ? (
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
