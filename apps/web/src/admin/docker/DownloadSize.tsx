import { formatBytes } from "../../monitor/format.js";

/** A download size, or a dash read out as "Not known" when the pull cache never held the image. */
export function DownloadSize({ bytes }: { bytes: number | null }) {
	if (bytes === null) {
		return (
			<>
				<span aria-hidden={true}>—</span>
				<span className="sr-only">Not known</span>
			</>
		);
	}
	return <>{formatBytes(bytes)}</>;
}
