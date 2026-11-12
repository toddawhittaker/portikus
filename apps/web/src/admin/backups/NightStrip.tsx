import { type Night, type NightKind, nightLabel } from "./model.js";

const KIND_TEXT: Record<NightKind, string> = {
	complete: "complete set",
	incomplete: "incomplete set",
	failed: "failed",
	none: "no set",
	scheduled: "scheduled",
};

/** Kinds the legend names, in the order they read. */
const LEGEND: readonly NightKind[] = [
	"complete",
	"incomplete",
	"failed",
	"none",
	"scheduled",
];

/**
 * The last fourteen nights as one row of squares, so a missed or failed
 * night shows at a glance. Each square names its night and result in words,
 * and the legend says what each look means, so colour is never the only sign.
 */
export function NightStrip({ nights }: { nights: readonly Night[] }) {
	const done = nights.filter((night) => night.kind === "complete").length;
	const past = nights.filter((night) => night.kind !== "scheduled").length;
	const shown = new Set(nights.map((night) => night.kind));
	return (
		<div className="pk-nights" data-testid="backups-nights">
			<p className="pk-nights-summary">
				<span className="pk-nights-count">
					{done} of {past}
				</span>{" "}
				recent nights left a complete set
			</p>
			<ol className="pk-nights-strip" aria-label="Recent nights, oldest first">
				{nights.map((night) => (
					<li
						key={night.day}
						className="pk-night"
						data-kind={night.kind}
						title={`${nightLabel(night.day)}: ${KIND_TEXT[night.kind]}`}
					>
						<span className="sr-only">
							{nightLabel(night.day)}: {KIND_TEXT[night.kind]}
						</span>
					</li>
				))}
			</ol>
			<ul className="pk-nights-legend" aria-hidden={true}>
				{LEGEND.filter((kind) => shown.has(kind)).map((kind) => (
					<li key={kind}>
						<span className="pk-night" data-kind={kind} />
						{KIND_TEXT[kind][0]?.toUpperCase()}
						{KIND_TEXT[kind].slice(1)}
					</li>
				))}
			</ul>
		</div>
	);
}
