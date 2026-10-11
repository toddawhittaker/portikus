import type { ImageSize } from "@portikus/contracts";
import { formatBytes } from "../../monitor/format.js";

/** A download size, or a dash read out as "Not known" when the pull cache never held the image. */
export function DownloadSize({ bytes }: { bytes: number | null }) {
	if (bytes === null) return <NotKnown />;
	return <>{formatBytes(bytes)}</>;
}

/** A seed image's size, saying whether it is unpacked on disk or the smaller download. */
export function ImageSizeText({ size }: { size: ImageSize | null }) {
	if (size === null) return <NotKnown />;
	return (
		<>
			{formatBytes(size.bytes)}{" "}
			<span className="pk-muted">{size.unpacked ? "on disk" : "download"}</span>
		</>
	);
}

function NotKnown() {
	return (
		<>
			<span aria-hidden={true}>—</span>
			<span className="sr-only">Not known</span>
		</>
	);
}
