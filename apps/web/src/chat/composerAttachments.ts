/**
 * Files attached to one chat message (SPEC.md §10.8). Each is saved in the
 * project first, with the helper the terminal's file drop uses, so `send`
 * carries project-relative paths and never file bytes. A picture too large
 * for Claude is made smaller in the browser first (fitImage.ts).
 */
import {
	ChatImageMediaType,
	MAX_CHAT_ATTACHMENTS,
	MAX_CHAT_IMAGE_BYTES,
	MAX_UPLOAD_BYTES,
} from "@portikus/contracts";
import { useToast } from "@portikus/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { fileErrorToast } from "../files/errors.js";
import { displayName } from "../files/paths.js";
import { saveDroppedFile, useFileMutations } from "../files/queries.js";
import { dropNameError, dropPaths } from "../terminal/terminalDrop.js";
import { fitImage } from "./fitImage.js";

export interface ComposerAttachment {
	key: string;
	/** Project-relative, where the file was saved. */
	path: string;
	name: string;
	/** An object URL for a picture's thumbnail; null for other files. */
	previewUrl: string | null;
	/** The saved size in bytes, which is smaller than the original for a shrunk picture. */
	size: number;
	/** For a long paste saved as a file, its line count, which the chip shows instead of the size. */
	lines: number | null;
}

/** Pictures Claude can read; SVG is left out because it can carry script. */
const THUMBNAIL_TYPES: readonly string[] = ChatImageMediaType.options;

const MAX_IMAGE_MB = MAX_CHAT_IMAGE_BYTES / (1024 * 1024);

/** Why `file` cannot join `count` files already attached, or null when it can (sizes aside). */
function attachmentRefusal(file: File, count: number): string | null {
	const name = displayName(file.name);
	if (count >= MAX_CHAT_ATTACHMENTS) {
		return `A message can carry ${MAX_CHAT_ATTACHMENTS} files. Remove one, or send this one in the next message.`;
	}
	if (file.type === "image/svg+xml" || /\.svgz?$/i.test(file.name)) {
		return `${name} is an SVG, which can carry script. Save it as PNG, JPEG, GIF or WebP, then attach that.`;
	}
	return dropNameError(file.name);
}

/** Why a file, after any shrinking, is still too large, or null when it fits. */
function sizeRefusal(file: File): string | null {
	const name = displayName(file.name);
	if (file.type.startsWith("image/") && file.size > MAX_CHAT_IMAGE_BYTES) {
		return `${name} is over ${MAX_IMAGE_MB} MB even when made smaller. Crop it or use a smaller picture.`;
	}
	if (file.size > MAX_UPLOAD_BYTES) {
		return `${name} is too large to upload. Use a smaller file.`;
	}
	return null;
}

/** The files that may join `count` already attached, and why the first other one may not. */
function sortOut(files: File[], count: number): { accepted: File[]; refused: string } {
	const accepted: File[] = [];
	let refused = "";
	for (const file of files) {
		const why = attachmentRefusal(file, count + accepted.length);
		if (why === null) accepted.push(file);
		else if (refused === "") refused = why;
	}
	return { accepted, refused };
}

function fileCount(count: number): string {
	return count === 1 ? "1 file" : `${count} files`;
}

const LINES = new Intl.NumberFormat();

export function lineText(lines: number): string {
	return lines === 1 ? "1 line" : `${LINES.format(lines)} lines`;
}

export function useComposerAttachments(workspaceId: string, projectId: string) {
	const toast = useToast();
	const deleteFile = useFileMutations(workspaceId, projectId).remove.mutate;
	const [items, setItems] = useState<ComposerAttachment[]>([]);
	const [saving, setSaving] = useState(0);
	const [refusal, setRefusal] = useState("");
	/** For the composer's status region: what just happened to the files. */
	const [status, setStatus] = useState("");
	// Counts files being saved too, so a quick second paste cannot pass the cap.
	const reserved = useRef(0);
	const urls = useRef(new Set<string>());
	const current = useRef(items);
	current.current = items;

	useEffect(() => {
		const known = urls.current;
		return () => {
			for (const url of known) URL.revokeObjectURL(url);
		};
	}, []);

	const add = useCallback(
		/**
		 * `lines` is given for a long paste saved as one text file. Resolves
		 * to the keys of the files attached.
		 */
		async (files: File[], lines: number | null = null): Promise<string[]> => {
			const { accepted, refused } = sortOut(files, reserved.current);
			reserved.current += accepted.length;
			setRefusal(refused);
			const keys: string[] = [];
			if (accepted.length === 0) return keys;
			setSaving((n) => n + accepted.length);
			setStatus(`Attaching ${fileCount(accepted.length)}…`);
			const now = new Date();
			let saved = 0;
			for (const [index, original] of accepted.entries()) {
				const file = (await fitImage(original)) ?? original;
				const tooLarge = sizeRefusal(file);
				if (tooLarge !== null) {
					reserved.current -= 1;
					setSaving((n) => n - 1);
					setRefusal(tooLarge);
					continue;
				}
				try {
					const path = await saveDroppedFile(
						workspaceId,
						projectId,
						dropPaths(now, file.name),
						file,
					);
					const previewUrl = THUMBNAIL_TYPES.includes(file.type)
						? URL.createObjectURL(file)
						: null;
					if (previewUrl) urls.current.add(previewUrl);
					const item = {
						key: crypto.randomUUID(),
						path,
						name: file.name,
						previewUrl,
						size: file.size,
						lines,
					};
					keys.push(item.key);
					// Known at once, so a discard straight after the save finds it before the next render.
					current.current = [...current.current, item];
					setItems((now) => [...now, item]);
					setSaving((n) => n - 1);
					saved += 1;
				} catch (error) {
					const left = accepted.length - index;
					reserved.current -= left;
					setSaving((n) => n - left);
					setStatus(saved > 0 ? `Attached ${fileCount(saved)}.` : "");
					toast.show(fileErrorToast(error));
					return keys;
				}
			}
			// A long paste says where it went, so nobody pastes it again thinking it was lost.
			const pasted = lines !== null && saved === 1 ? accepted[0] : undefined;
			setStatus(
				pasted
					? `Pasted ${lineText(lines as number)}, attached as ${displayName(pasted.name)}.`
					: saved > 0
						? `Attached ${fileCount(saved)}.`
						: "",
			);
			return keys;
		},
		[workspaceId, projectId, toast],
	);

	const remove = useCallback((key: string) => {
		setItems((current) => {
			const gone = current.find((item) => item.key === key);
			if (gone?.previewUrl) {
				URL.revokeObjectURL(gone.previewUrl);
				urls.current.delete(gone.previewUrl);
			}
			if (gone) setStatus(`Removed ${displayName(gone.name)}.`);
			return current.filter((item) => item.key !== key);
		});
		reserved.current -= 1;
		setRefusal("");
	}, []);

	/**
	 * Take back a long paste's text file, which has no thumbnail, and delete
	 * the copy saved in the project. The chip goes even if the delete fails;
	 * the copy then stays in `.portikus/pastes`, where nothing reads it.
	 */
	const discard = useCallback(
		/** `said` is what the status region announces. */
		(key: string, said: string) => {
			const gone = current.current.find((item) => item.key === key);
			if (!gone) return;
			reserved.current -= 1;
			current.current = current.current.filter((item) => item.key !== key);
			setItems((now) => now.filter((item) => item.key !== key));
			setStatus(said);
			deleteFile(gone.path);
		},
		[deleteFile],
	);

	/** Drop the files that went with a message; any attached since then stay. */
	const clear = useCallback((keys: readonly string[]) => {
		const sent = new Set(keys);
		const gone = current.current.filter((item) => sent.has(item.key));
		for (const item of gone) {
			if (!item.previewUrl) continue;
			URL.revokeObjectURL(item.previewUrl);
			urls.current.delete(item.previewUrl);
		}
		reserved.current -= gone.length;
		setItems((now) => now.filter((item) => !sent.has(item.key)));
		setRefusal("");
	}, []);

	return { items, saving, refusal, status, add, remove, discard, clear };
}
