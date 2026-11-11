import { type ReactNode, useEffect } from "react";
import type { HelpPart } from "./content/part.js";

/** The id a `#hash` names; a malformed escape names nothing rather than throwing. */
export function anchorId(hash: string): string {
	try {
		return decodeURIComponent(hash.slice(1));
	} catch {
		return "";
	}
}

type Topic = HelpPart["topics"][number];

/** A part's topics cut where a topic starts a named group; a part with no groups is one untitled run. */
function topicGroups(topics: Topic[]): { title?: string; topics: Topic[] }[] {
	const groups: { title?: string; topics: Topic[] }[] = [];
	for (const topic of topics) {
		const last = groups.at(-1);
		if (!last || topic.group) groups.push({ title: topic.group, topics: [topic] });
		else last.topics.push(topic);
	}
	return groups;
}

/**
 * One help page inside the caller's `main`: its h1, an optional line pointing
 * to the other help page, the contents, and the parts (SPEC.md section 8.6).
 */
export function HelpDocument({
	title,
	titleId,
	parts,
	elsewhere,
}: {
	title: string;
	titleId: string;
	parts: HelpPart[];
	/** A sentence linking to the other help page, for readers who have one. */
	elsewhere?: ReactNode;
}) {
	const shownIds = parts.map((part) => part.id).join(" ");

	// The page arrives after the browser looked for the #anchor, so go there
	// once it exists, and move focus too so Tab and screen readers start there.
	useEffect(() => {
		const id = anchorId(window.location.hash);
		if (!id || !shownIds) return;
		const target = document.getElementById(id);
		target?.scrollIntoView();
		target?.focus({ preventScroll: true });
	}, [shownIds]);

	return (
		<div className="pk-help mx-auto w-full max-w-[1440px]">
			<h1 className="pk-text-display" id={titleId}>
				{title}
			</h1>
			{elsewhere ? <p className="pk-help-elsewhere">{elsewhere}</p> : null}
			<div className="pk-help-layout">
				<nav aria-label="Help contents" className="pk-help-nav">
					<ol className="pk-help-toc">
						{parts.map((part) => (
							<li key={part.id} className="pk-help-toc-part">
								<a href={`#${part.id}`}>{part.title}</a>
								{topicGroups(part.topics).map((group) => (
									<div key={group.topics[0]?.id} className="pk-help-toc-group">
										{group.title ? (
											<span
												className="pk-help-toc-group-title"
												id={`toc-${group.topics[0]?.id}`}
											>
												{group.title}
											</span>
										) : null}
										<ol
											className="pk-help-toc-sub"
											aria-labelledby={
												group.title ? `toc-${group.topics[0]?.id}` : undefined
											}
										>
											{group.topics.map((topic) => (
												<li key={topic.id}>
													<a href={`#${topic.id}`}>{topic.title}</a>
												</li>
											))}
										</ol>
									</div>
								))}
							</li>
						))}
					</ol>
				</nav>
				<article className="pk-help-article">
					{parts.map((part) => (
						<section key={part.id} aria-labelledby={part.id}>
							<h2 className="pk-text-heading" id={part.id} tabIndex={-1}>
								{part.title}
							</h2>
							{part.topics.map((topic) => (
								<section key={topic.id}>
									<h3 id={topic.id} tabIndex={-1}>
										{topic.title}
									</h3>
									{topic.body}
								</section>
							))}
						</section>
					))}
				</article>
			</div>
		</div>
	);
}
