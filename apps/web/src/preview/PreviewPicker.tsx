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
import { MIN_PREVIEW_PORT } from "./grants.js";
import "./preview.css";

/** The complaint about a typed port, or null when it may be previewed. */
export function portError(text: string): string | null {
	if (!/^\d{1,5}$/.test(text.trim())) return "Enter a port number.";
	const port = Number(text.trim());
	if (port > 65535) return "Ports go up to 65535.";
	if (port < MIN_PREVIEW_PORT) {
		return `Ports below ${MIN_PREVIEW_PORT} are reserved. Run your application on a higher port.`;
	}
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
