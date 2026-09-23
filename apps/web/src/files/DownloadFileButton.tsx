import { useToast } from "@portikus/ui";
import { downloadErrorToast } from "./errors.js";
import { baseName } from "./paths.js";
import { downloadCheckUrl, fileDownloadUrl, startDownload } from "./queries.js";

/**
 * The Download control for one file in an editor or diff tab. A button, so
 * the size check runs first and a refusal is explained, not a silent failed
 * download (#399).
 */
export function DownloadFileButton({
	workspaceId,
	projectId,
	path,
	testId,
}: {
	workspaceId: string;
	projectId: string;
	path: string;
	testId: string;
}) {
	const toast = useToast();
	return (
		<button
			type="button"
			className="pk-file-download"
			data-testid={testId}
			aria-label={`Download ${baseName(path)}`}
			onClick={() => {
				startDownload(
					fileDownloadUrl(workspaceId, projectId, path),
					downloadCheckUrl(workspaceId, projectId, path),
					baseName(path),
				).catch((error: unknown) => toast.show(downloadErrorToast(error)));
			}}
		>
			Download
		</button>
	);
}
