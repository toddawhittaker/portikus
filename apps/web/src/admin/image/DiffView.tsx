import type { ImageDiff } from "@portikus/contracts";
import { Skeleton } from "@portikus/ui";
import { errorText } from "../../api/request.js";
import { useImageDiff } from "./queries.js";

/** heading is the level of Tools and Packages under wherever the diff is shown. */
export function DiffView({
	from,
	to,
	heading,
}: {
	from: string;
	to: string;
	heading: "h3" | "h5";
}) {
	const diff = useImageDiff(from, to);
	if (diff.isError) {
		return (
			<p className="text-status-error m-0 text-[13px]" role="alert">
				{errorText(diff.error)}
			</p>
		);
	}
	if (!diff.data) return <Skeleton variant="block" height={80} />;
	return (
		<div className="grid gap-4 text-[13px]" data-testid="image-diff">
			<DiffPart
				title="Tools"
				heading={heading}
				part={diff.data.tools}
				testId="image-diff-tools"
			/>
			<DiffPart
				title="Packages"
				heading={heading}
				part={diff.data.packages}
				testId="image-diff-packages"
			/>
		</div>
	);
}

function DiffPart({
	title,
	heading: Heading,
	part,
	testId,
}: {
	title: string;
	heading: "h3" | "h5";
	part: ImageDiff["tools"];
	testId: string;
}) {
	const none = part.added.length + part.removed.length + part.changed.length === 0;
	return (
		<div data-testid={testId}>
			<Heading className="m-0 mb-1 text-[13px] font-semibold">{title}</Heading>
			{none ? (
				<p className="pk-muted m-0">No changes.</p>
			) : (
				<ul className="m-0 grid list-none gap-1 p-0">
					{part.changed.map((c) => (
						<li key={`c-${c.name}`}>
							Changed <strong>{c.name}</strong>: {c.from} to {c.to}
						</li>
					))}
					{part.added.map((a) => (
						<li key={`a-${a.name}`}>
							Added <strong>{a.name}</strong> {a.version}
						</li>
					))}
					{part.removed.map((r) => (
						<li key={`r-${r.name}`}>
							Removed <strong>{r.name}</strong> {r.version}
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
