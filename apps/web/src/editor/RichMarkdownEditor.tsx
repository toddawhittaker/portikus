/**
 * The rich view of a Markdown file: a what-you-see editor with a toolbar,
 * over the same Markdown text the code view edits (SPEC.md §13.4, issue
 * #155). MDXEditor keeps Markdown as the truth, so an edit here produces
 * Markdown text that goes through the tab's ordinary save path (ADR 0017).
 *
 * Raw HTML is not processed (`suppressHtmlProcessing`), so a tag a coding
 * agent wrote stays text instead of becoming markup in the control-plane
 * origin (SPEC.md §24.2), the same promise the read-only preview made. It is
 * shown as its own source text instead, by the visitor in
 * `verbatimMarkdown.ts`; without one, MDXEditor throws on the first HTML node
 * and the rest of the file never appears.
 */
import {
	BlockTypeSelect,
	BoldItalicUnderlineToggles,
	CodeToggle,
	CreateLink,
	codeBlockPlugin,
	frontmatterPlugin,
	headingsPlugin,
	InsertCodeBlock,
	InsertTable,
	InsertThematicBreak,
	imagePlugin,
	ListsToggle,
	linkDialogPlugin,
	linkPlugin,
	listsPlugin,
	MDXEditor,
	type MDXEditorMethods,
	markdownShortcutPlugin,
	quotePlugin,
	Separator,
	tablePlugin,
	thematicBreakPlugin,
	toolbarPlugin,
	UndoRedo,
} from "@mdxeditor/editor";
import { type Ref, useEffect, useRef } from "react";
import { debounce, endWithNewline, hasChanged } from "./markdownSync.js";
import { verbatimPlugin } from "./verbatimMarkdown.js";
import "@mdxeditor/editor/style.css";
import "./markdown.css";
import "./rich-markdown.css";

/** How long typing has to pause before the code side is rewritten. */
const SYNC_DELAY_MS = 300;

/**
 * Serialization that matches what a student is most likely to have typed by
 * hand, so switching to the rich view and back does not rewrite the file in a
 * different Markdown dialect.
 */
export const TO_MARKDOWN = {
	bullet: "-",
	emphasis: "*",
	strong: "*",
	fence: "`",
	listItemIndent: "one",
} as const;

export const PLUGINS = [
	// First, so its visitors outrank the image plugin's raw-HTML visitor.
	verbatimPlugin(),
	headingsPlugin(),
	listsPlugin(),
	quotePlugin(),
	linkPlugin(),
	linkDialogPlugin(),
	tablePlugin(),
	thematicBreakPlugin(),
	frontmatterPlugin(),
	// Markdown images (`![alt](src)`) are rendered; nothing may be dragged,
	// pasted or uploaded in, and an unsafe address never reaches this plugin
	// because the verbatim visitor claims it first.
	imagePlugin({ disableImageResize: true, disableImageSettingsButton: true }),
	codeBlockPlugin({ defaultCodeBlockLanguage: "" }),
	markdownShortcutPlugin(),
	toolbarPlugin({
		toolbarContents: () => (
			<>
				<UndoRedo />
				<Separator />
				<BoldItalicUnderlineToggles />
				<CodeToggle />
				<Separator />
				<BlockTypeSelect />
				<Separator />
				<ListsToggle />
				<Separator />
				<CreateLink />
				<InsertCodeBlock />
				<InsertTable />
				<InsertThematicBreak />
			</>
		),
	}),
];

export interface RichMarkdownEditorProps {
	/** The file's Markdown text. */
	text: string;
	/** Called with new Markdown when the student edits here. */
	onChange: (text: string) => void;
	/** The scrolling element, so the split view can follow the code side. */
	scrollRef?: Ref<HTMLDivElement>;
	onScroll?: () => void;
	/**
	 * Called when MDXEditor cannot read the file. While it is in that state it
	 * shows only part of the file and drops every keystroke, so the tab must
	 * move the student to the code view.
	 */
	onUnsupported?: () => void;
}

export function RichMarkdownEditor({
	text,
	onChange,
	scrollRef,
	onScroll,
	onUnsupported,
}: RichMarkdownEditorProps) {
	const editor = useRef<MDXEditorMethods | null>(null);
	// The last text this editor produced or was given: the loop guard.
	const seen = useRef(text);
	// The parent's callback changes every render, so the debounce reads it
	// through a ref rather than being rebuilt and losing its pending call.
	const report = useRef(onChange);
	report.current = onChange;
	// MDXEditor subscribes to `onError` once, at mount, so it too is read
	// through a ref rather than captured.
	const unsupported = useRef(onUnsupported);
	unsupported.current = onUnsupported;

	const push = useRef(
		debounce<string>((value) => {
			report.current(value);
		}, SYNC_DELAY_MS),
	);

	// Whatever is pending when the student leaves the rich view must still
	// reach the buffer, or those keystrokes are lost.
	useEffect(() => {
		const pending = push.current;
		return () => {
			pending.flush();
		};
	}, []);

	// True while text from the code side is being loaded. Loading reformats
	// the document, which MDXEditor reports as a change; sending that back
	// would mark the file unsaved and rewrite it because of a keystroke on
	// the other side.
	const loading = useRef(false);

	// An edit on the code side has to be loaded here; MDXEditor reads its
	// `markdown` prop only when it mounts.
	useEffect(() => {
		if (!hasChanged(seen.current, text)) return;
		seen.current = text;
		push.current.cancel();
		loading.current = true;
		editor.current?.setMarkdown(text);
		queueMicrotask(() => {
			loading.current = false;
		});
	}, [text]);

	return (
		<div
			className="pk-rich-markdown"
			data-testid="markdown-rich"
			ref={scrollRef}
			onScroll={onScroll}
		>
			<MDXEditor
				ref={editor}
				markdown={text}
				plugins={PLUGINS}
				toMarkdownOptions={TO_MARKDOWN}
				suppressHtmlProcessing
				onError={() => {
					unsupported.current?.();
				}}
				contentEditableClassName="pk-rich-markdown-body pk-markdown"
				onChange={(markdown, initialNormalize) => {
					const next = endWithNewline(markdown);
					// Opening a file or loading the code side's text must not
					// make the file unsaved, so the tidy-up MDXEditor does to
					// the text it was handed is not an edit.
					if (initialNormalize || loading.current) {
						seen.current = next;
						return;
					}
					if (!hasChanged(seen.current, next)) return;
					seen.current = next;
					push.current.call(next);
				}}
			/>
		</div>
	);
}
