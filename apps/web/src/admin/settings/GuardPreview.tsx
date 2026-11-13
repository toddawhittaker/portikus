import "./settings.css";
import type { NumberKey } from "./numberSettings.js";

/** The guard's keys a preview reads. */
type PreviewKey = Extract<
	NumberKey,
	| "guardWindowMinutes"
	| "cpuGuardThresholdPercent"
	| "cpuThrottleSharePercent"
	| "cpuIdleLiftMinutes"
	| "cpuIdleLiftPercent"
	| "memoryGuardThresholdPercent"
>;
type Value = (key: PreviewKey) => string | undefined;

/** A box's text as a whole number, or null while it holds something else. */
function whole(text: string | undefined): number | null {
	const trimmed = text?.trim() ?? "";
	return /^\d+$/.test(trimmed) ? Number(trimmed) : null;
}

function minutes(n: number): string {
	return n === 1 ? "1 minute" : `${n} minutes`;
}

/**
 * The guard's main rules as one sentence built from the boxes, saved or not,
 * so an administrator sees what the numbers do together before saving
 * (SPEC.md section 19.4). A box that does not hold a number yet reads as "…".
 */
function guardSentences(value: Value): { cpu: string[]; memory: string } {
	const window = whole(value("guardWindowMinutes"));
	const threshold = whole(value("cpuGuardThresholdPercent"));
	const share = whole(value("cpuThrottleSharePercent"));
	const quiet = whole(value("cpuIdleLiftMinutes"));
	const quietUnder = whole(value("cpuIdleLiftPercent"));
	const memory = whole(value("memoryGuardThresholdPercent"));
	const period = window === null ? "…" : minutes(window);
	const cpu =
		threshold === 100
			? ["Slowing is off: no workspace is slowed for heavy CPU use."]
			: [
					"If a workspace averages more than ",
					`${threshold ?? "…"}% CPU for ${period}`,
					", it runs at ",
					`${share ?? "…"}% of its CPUs`,
					quietUnder === 0
						? " until you lift the slowdown."
						: ` until it stays quiet for ${quiet === null ? "…" : minutes(quiet)}.`,
				];
	const memoryText =
		memory === 100
			? "Memory flagging is off."
			: `Memory above ${memory ?? "…"}% of its limit over ${period} is flagged on Health and Users; nothing is slowed.`;
	return { cpu, memory: memoryText };
}

/** The guard's rules in plain words, above its boxes. */
export function GuardPreview({ value }: { value: Value }) {
	const { cpu, memory } = guardSentences(value);
	return (
		<div className="pk-guard-preview" data-testid="guard-preview">
			<p className="pk-overline">In plain words</p>
			<p className="pk-guard-preview-line">
				{cpu.map((part, index) =>
					// The odd parts are the figures, set in weight 600 so they read first.
					index % 2 === 1 ? (
						<strong key={part}>{part}</strong>
					) : (
						<span key={part}>{part}</span>
					),
				)}
			</p>
			<p className="pk-guard-preview-line pk-muted">{memory}</p>
		</div>
	);
}
