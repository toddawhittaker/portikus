/** A root job's log under its heading, for the Image and Certificate tabs. */
export function JobLog({ idPrefix, log }: { idPrefix: string; log: string[] }) {
	const titleId = `${idPrefix}-log-title`;
	return (
		<div className="grid gap-2">
			<h4 className="pk-text-compact m-0 font-semibold text-ink-muted" id={titleId}>
				Log
			</h4>
			{/* Focusable so it scrolls by keyboard (SPEC.md section 25.8); plain text, never HTML. */}
			<section
				className="pk-focus-inset max-h-80 overflow-auto"
				data-testid={`${idPrefix}-job-log`}
				aria-labelledby={titleId}
				// biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region must take focus
				tabIndex={0}
			>
				<pre className="pk-techdetail m-0 whitespace-pre-wrap break-all">
					{log.length > 0 ? log.join("\n") : "No output yet."}
				</pre>
			</section>
		</div>
	);
}
