/**
 * The Running surface (SPEC.md §18.2, DESIGN.md "Running services"): one
 * row per listening port, with an Open preview action for the ports policy
 * allows. It explains what is running; it does not replace `ps` or
 * `docker ps`.
 */
import { EmptyState } from "@portikus/ui";
import "../preview/preview.css";
import {
	isPreviewable,
	serviceCommand,
	serviceKind,
	useListening,
} from "./services.js";

export interface RunningPaneProps {
	/** Ports that have a saved preview tab, so a stale one can be marked. */
	previewPorts: number[];
	onOpenPreview: (port: number) => void;
}

export function RunningPane({ previewPorts, onOpenPreview }: RunningPaneProps) {
	const listening = useListening();
	const services = [...listening.services].sort((a, b) => a.port - b.port);
	const live = new Set(services.map((service) => service.port));
	// A preview tab whose port stopped listening is said so here, rather than
	// leaving the student to guess (SPEC.md §18.2).
	const stale = previewPorts.filter((port) => !live.has(port)).sort((a, b) => a - b);

	return (
		<div className="pk-pane-body" data-testid="running-list">
			{services.length === 0 && stale.length === 0 ? (
				<EmptyState icon="play" title="Nothing is running yet">
					Start an application in a terminal and its port appears here.
				</EmptyState>
			) : null}

			{services.map((service) => (
				<div
					key={service.port}
					className="pk-portrow"
					data-testid={`running-row-${service.port}`}
				>
					<span className="pk-portrow-port">{service.port}</span>
					<span>{serviceCommand(service)}</span>
					<span className="pk-portrow-kind">{serviceKind(service)}</span>
					{isPreviewable(service) ? (
						<button
							type="button"
							className="pk-preview-action"
							data-testid={`running-open-${service.port}`}
							onClick={() => onOpenPreview(service.port)}
						>
							Open preview
						</button>
					) : null}
				</div>
			))}

			{stale.map((port) => (
				<div key={port} className="pk-portrow" data-testid={`running-stale-${port}`}>
					<span className="pk-portrow-port">{port}</span>
					<span className="pk-portrow-kind">not running</span>
					<span className="pk-portrow-kind">Preview</span>
					<span />
				</div>
			))}
		</div>
	);
}
