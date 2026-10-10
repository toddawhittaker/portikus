/**
 * One file of a shared project: its text read-only, or an image or PDF shown
 * inline (SPEC.md §5.2, ADR 0057). There is no Download here on purpose.
 */
import { EmptyState } from "@portikus/ui";
import { lazy, type ReactNode, Suspense } from "react";
import { ApiError, errorText } from "../../api/request.js";
import { baseName, displayName, parentOf } from "../../files/paths.js";
import { viewerKind } from "../../files/viewable.js";
import { ImageView, PdfView } from "../../work/FileViewer.js";
import "../../work/work.css";
import {
	type ShareRef,
	sharedInlineUrl,
	useSharedFile,
	useSharedTree,
} from "./queries.js";

// Monaco is large, so it loads only when a text file is opened (STACK.md §3).
const ReadOnlyText = lazy(() =>
	import("./ReadOnlyText.js").then((module) => ({ default: module.ReadOnlyText })),
);

/** What a viewer shows when it cannot show the file. */
function fallback(title: string): ReactNode {
	return (
		<EmptyState icon="file" title={title}>
			Only the student can download it from their workspace.
		</EmptyState>
	);
}

export function SharedFileView({ share, path }: { share: ShareRef; path: string }) {
	const kind = viewerKind(path);
	if (kind !== null)
		return <SharedPicture share={share} path={path} pdf={kind === "pdf"} />;
	return <SharedText share={share} path={path} />;
}

/**
 * An image or PDF. Its address carries the size and modified time from the
 * listing the tree already polls, so a changed file is a new address.
 */
function SharedPicture({
	share,
	path,
	pdf,
}: {
	share: ShareRef;
	path: string;
	pdf: boolean;
}) {
	const listing = useSharedTree(share, parentOf(path));
	const entry = listing.data?.entries.find((item) => item.name === baseName(path));
	const version = entry ? `${entry.size}-${entry.mtimeMs}` : undefined;
	const src = sharedInlineUrl(share, path, version);
	return pdf ? (
		<PdfView url={src} path={path} download={null} fallback={fallback} />
	) : (
		<ImageView
			src={src}
			path={path}
			size={entry?.size}
			download={null}
			fallback={fallback}
		/>
	);
}

function SharedText({ share, path }: { share: ShareRef; path: string }) {
	const file = useSharedFile(share, path);
	const name = displayName(baseName(path));
	if (file.error && !file.data) {
		const missing =
			file.error instanceof ApiError && file.error.code === "FILE_NOT_FOUND";
		return (
			<EmptyState icon="file" title="This file could not be shown">
				<span data-testid="shared-file-error">
					{missing
						? `${name} is no longer in the project.`
						: errorText(
								file.error,
								"The workspace did not answer. It is asked again shortly.",
							)}
				</span>
			</EmptyState>
		);
	}
	if (!file.data) return <p className="pk-file-note">Loading…</p>;
	if (file.data.tooLarge) return fallback("This file is too large to show here");
	if (file.data.binary) return fallback(`${name} is not text, so it is not shown here`);
	return (
		<Suspense fallback={<p className="pk-file-note">Loading…</p>}>
			<ReadOnlyText key={path} path={path} text={file.data.text} />
		</Suspense>
	);
}
