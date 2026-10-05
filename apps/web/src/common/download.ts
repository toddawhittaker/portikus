/** Hand a blob to the browser as a downloaded file; nothing keeps a copy. */
export function downloadBlob(fileName: string, blob: Blob): void {
	const url = URL.createObjectURL(blob);
	const link = document.createElement("a");
	link.href = url;
	link.download = fileName;
	document.body.append(link);
	link.click();
	link.remove();
	// Revoked once the browser has started the download, not before.
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}
