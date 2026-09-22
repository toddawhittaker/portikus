/**
 * The confirmation for one `browser.open.request` frame
 * (BROWSER-HANDLING.md §18, §19.1, §21.2). Opening happens only on the
 * click. A loopback preview uses the preview the app already has; a
 * loopback login is explained and not opened.
 */
import { type BrowserOpenRequest, classifyBrokerUrl } from "@portikus/contracts";
import { Button, Dialog, DialogRoot, useToast } from "@portikus/ui";
import { useState } from "react";
import { previewRouteFor } from "../links.js";

export interface BrowserOpenDialogProps {
	request: BrowserOpenRequest;
	workspaceId: string;
	projectId: string;
	/** The preview tab the rest of the app already opens for a port. */
	onOpenPreview: (port: number) => void;
	onClose: () => void;
}

/** http(s) only. `javascript:` and every other scheme stop here. */
function httpUrl(raw: string): URL | null {
	const classified = classifyBrokerUrl(raw);
	if (classified.outcome === "reject") return null;
	try {
		const url = new URL(raw);
		if (url.protocol !== "http:" && url.protocol !== "https:") return null;
		return url;
	} catch {
		return null;
	}
}

export function BrowserOpenDialog({
	request,
	workspaceId,
	projectId,
	onOpenPreview,
	onClose,
}: BrowserOpenDialogProps) {
	const toast = useToast();
	const [copyError, setCopyError] = useState<{ id: string; message: string } | null>(
		null,
	);
	const url = httpUrl(request.url);
	const login = request.brokerClass === "loopback-login";
	const preview = request.brokerClass === "loopback-preview";
	const classified = url ? classifyBrokerUrl(request.url) : null;
	const origin = url ? url.origin : null;
	const httpWarning =
		url !== null && url.protocol === "http:" && classified?.outcome === "external";
	const executable = request.source?.executable;
	const previewRoute =
		preview && url ? previewRouteFor(request.url, workspaceId, projectId) : null;
	// Login never navigates. Preview only when the existing route accepts the
	// port. Anything else must be an external http(s) URL.
	const canOpen = login
		? false
		: preview
			? previewRoute?.kind === "preview"
			: classified?.outcome === "external";
	// Copy is only for an external http(s) URL. classifyBrokerUrl already
	// keeps loopback and private hosts off that outcome (BROWSER-HANDLING.md §18).
	const canCopy = classified?.outcome === "external";

	function open() {
		if (!canOpen || !url) return;
		if (url.protocol !== "http:" && url.protocol !== "https:") return;
		if (preview) {
			if (previewRoute?.kind !== "preview") return;
			onOpenPreview(Number(previewRoute.params.port));
			onClose();
			return;
		}
		window.open(request.url, "_blank", "noopener,noreferrer");
		onClose();
	}

	async function copy() {
		if (!canCopy) return;
		try {
			const write = navigator.clipboard?.writeText;
			if (!write) throw new Error("clipboard unavailable");
			await write.call(navigator.clipboard, request.url);
		} catch {
			setCopyError({ id: request.requestId, message: "The link could not be copied." });
			return;
		}
		toast.show({ tone: "success", title: "Link copied" });
		onClose();
	}

	const asked = "A program in the workspace asked to open a link.";

	return (
		<DialogRoot
			key={request.requestId}
			open
			onOpenChange={(next) => {
				if (!next) onClose();
			}}
		>
			<Dialog
				testId="browser-open-dialog"
				title="Open this link?"
				description={
					<>
						{asked}{" "}
						{origin ? (
							<span data-testid="browser-open-origin">{origin}</span>
						) : (
							<span data-testid="browser-open-rejected">
								This link cannot be opened.
							</span>
						)}
						{login ? (
							<>
								{" "}
								<span data-testid="browser-open-login">
									The workspace cannot receive a callback on localhost. Run{" "}
									<code>codex login --device-auth</code> and finish signing in from the
									code the terminal shows.
								</span>
							</>
						) : null}
					</>
				}
				footer={
					<>
						<Button variant="quiet" data-testid="browser-open-cancel" onClick={onClose}>
							Cancel
						</Button>
						{canCopy ? (
							<Button data-testid="browser-open-copy" onClick={() => void copy()}>
								Copy link
							</Button>
						) : null}
						{canOpen ? (
							<Button
								variant="primary"
								data-testid="browser-open-confirm"
								onClick={open}
							>
								{preview ? "Open preview" : "Open in my browser"}
							</Button>
						) : null}
					</>
				}
			>
				{executable ? (
					<p data-testid="browser-open-executable">Started by {executable}</p>
				) : null}
				{httpWarning ? (
					<p role="status" data-testid="browser-open-http-warning">
						This link is plain HTTP, so it is not encrypted.
					</p>
				) : null}
				{copyError?.id === request.requestId ? (
					<p role="alert" data-testid="browser-open-copy-error">
						{copyError.message}
					</p>
				) : null}
			</Dialog>
		</DialogRoot>
	);
}
