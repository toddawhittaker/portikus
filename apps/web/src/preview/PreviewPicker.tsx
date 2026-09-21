/**
 * The `+ Preview` launcher (SPEC.md §14.6, DESIGN.md "Terminal tabs").
 * It lists the ports the workspace agent found listening and lets the
 * student name another one, because discovery is a help rather than a rule.
 */
import { Button, Dialog, DialogRoot, TextField } from "@portikus/ui";
import { useState } from "react";
import {
	isPreviewable,
	serviceCommand,
	serviceKind,
	useListening,
} from "../running/services.js";
import "./preview.css";

/**
 * The complaint about a typed port, or null when it is a port number at all.
 *
 * Which ports may be previewed is the API's policy (PREVIEW_PORT_MIN,
 * PREVIEW_PORT_MAX and PREVIEW_DENIED_PORTS). Repeating it here would let
 * the two drift apart, so the launcher only checks that the text is a port
 * number and lets the grant route's 403 sentence explain any refusal.
 */
export function portError(text: string): string | null {
	if (!/^\d{1,5}$/.test(text.trim())) return "Enter a port number.";
	const port = Number(text.trim());
	if (port < 1 || port > 65535) return "Ports go from 1 to 65535.";
	return null;
}

export function PreviewPicker({
	onOpen,
	onClose,
}: {
	onOpen: (port: number) => void;
	onClose: () => void;
}) {
	const listening = useListening();
	const [text, setText] = useState("");
	const [touched, setTouched] = useState(false);
	const error = portError(text);
	const offered = listening.services.filter(isPreviewable);

	function submit() {
		setTouched(true);
		if (error) return;
		onOpen(Number(text.trim()));
	}

	return (
		<DialogRoot open onOpenChange={(open) => !open && onClose()}>
			<Dialog
				testId="dialog-preview-port"
				title="Open a preview"
				description="Pick a port that is listening, or enter one yourself."
				onClose={onClose}
				footer={
					<Button variant="primary" onClick={submit} data-testid="preview-open-port">
						Open preview
					</Button>
				}
			>
				<div className="pk-portlist" data-testid="preview-port-list">
					{offered.length === 0 ? (
						<p className="pk-portrow-kind">Nothing is listening yet.</p>
					) : (
						offered.map((service) => (
							<button
								key={service.port}
								type="button"
								className="pk-portrow"
								data-testid={`preview-port-${service.port}`}
								onClick={() => onOpen(service.port)}
							>
								<span className="pk-portrow-port">{service.port}</span>
								<span>{serviceCommand(service)}</span>
								<span className="pk-portrow-kind">{serviceKind(service)}</span>
							</button>
						))
					)}
				</div>
				<div className="pk-portform">
					<TextField
						id="preview-port"
						label="Port"
						value={text}
						inputMode="numeric"
						error={touched && error ? error : undefined}
						onChange={(event) => setText(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter") submit();
						}}
					/>
				</div>
			</Dialog>
		</DialogRoot>
	);
}
