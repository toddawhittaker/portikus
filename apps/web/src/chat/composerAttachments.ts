/**
 * Files attached to one chat message (SPEC.md §10.8). Each is saved in the
 * project first, with the helper the terminal's file drop uses, so `send`
 * carries project-relative paths and never file bytes.
 */
import {
	MAX_CHAT_ATTACHMENTS,
	MAX_CHAT_IMAGE_BYTES,
	MAX_UPLOAD_BYTES,
} from "@portikus/contracts";
import { useToast } from "@portikus/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { fileErrorToast } from "../files/errors.js";
import { displayName } from "../files/paths.js";
import { saveDroppedFile } from "../files/queries.js";
import { dropNameError, dropPaths } from "../terminal/terminalDrop.js";

export interface ComposerAttachment {
	key: string;
	/** Project-relative, where the file was saved. */
	path: string;
	name: string;
	/** An object URL for a picture's thumbnail; null for other files. */
	previewUrl: string | null;
}

/** Pictures Claude can read; SVG is left out because it can carry script. */
const THUMBNAIL_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

const MAX_IMAGE_MB = MAX_CHAT_IMAGE_BYTES / (1024 * 1024);

/** Why `file` cannot join `count` files already attached, or null when it can. */
function attachmentRefusal(file: File, count: number): string | null {
	const name = displayName(file.name);
	if (count >= MAX_CHAT_ATTACHMENTS) {
		return `A message can carry ${MAX_CHAT_ATTACHMENTS} files. Remove one, or send this one in the next message.`;
	}
	if (file.type === "image/svg+xml" || /\.svgz?$/i.test(file.name)) {
		return `${name} is an SVG, which can carry script. Save it as PNG, JPEG, GIF or WebP, then attach that.`;
	}
	if (file.type.startsWith("image/") && file.size > MAX_CHAT_IMAGE_BYTES) {
		return `${name} is over ${MAX_IMAGE_MB} MB. Use a smaller picture.`;
	}
	if (file.size > MAX_UPLOAD_BYTES) {
		return `${name} is too large to upload. Use a smaller file.`;
	}
	return dropNameError(file.name);
}

export function useComposerAttachments(workspaceId: string, projectId: string) {
	const toast = useToast();
	const [items, setItems] = useState<ComposerAttachment[]>([]);
	const [saving, setSaving] = useState(0);
	const [refusal, setRefusal] = useState("");
	// Counts files being saved too, so a quick second paste cannot pass the cap.
	const reserved = useRef(0);
	const urls = useRef(new Set<string>());

	useEffect(() => {
		const known = urls.current;
		return () => {
			for (const url of known) URL.revokeObjectURL(url);
		};
	}, []);

	const add = useCallback(
		async (files: File[]) => {
			const accepted: File[] = [];
			let refused = "";
			for (const file of files) {
				const why = attachmentRefusal(file, reserved.current);
				if (why === null) {
					accepted.push(file);
					reserved.current += 1;
				} else if (refused === "") {
					refused = why;
				}
			}
			setRefusal(refused);
			if (accepted.length === 0) return;
			setSaving((n) => n + accepted.length);
			const now = new Date();
			for (const [index, file] of accepted.entries()) {
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
					setItems((current) => [
						...current,
						{ key: crypto.randomUUID(), path, name: file.name, previewUrl },
					]);
					setSaving((n) => n - 1);
				} catch (error) {
					const left = accepted.length - index;
					reserved.current -= left;
					setSaving((n) => n - left);
					toast.show(fileErrorToast(error));
					return;
				}
			}
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
			return current.filter((item) => item.key !== key);
		});
		reserved.current -= 1;
		setRefusal("");
	}, []);

	const clear = useCallback(() => {
		for (const url of urls.current) URL.revokeObjectURL(url);
		urls.current.clear();
		reserved.current = 0;
		setItems([]);
		setRefusal("");
	}, []);

	return { items, saving, refusal, add, remove, clear };
}
