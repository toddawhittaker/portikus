import { Icon } from "@portikus/ui";

/**
 * A preflight or DNS check's result: a passed check is a quiet tick and word,
 * only a warning or a failure gets a badge. One width for all three words,
 * so the check names beside them line up.
 */
export function CheckResult({ result }: { result: string }) {
	return (
		<span
			className={`w-18 ${
				result === "failed"
					? "pk-tag pk-tag--error"
					: result === "warning"
						? "pk-tag pk-tag--warning"
						: "inline-flex items-center gap-1 text-[12px] font-semibold leading-[22px] text-status-running"
			}`}
		>
			{result === "failed" ? (
				"Failed"
			) : result === "warning" ? (
				"Warning"
			) : (
				<>
					<Icon name="check" size="sm" />
					Passed
				</>
			)}
		</span>
	);
}
