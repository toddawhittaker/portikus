import type { ReactNode } from "react";

/** One topic: an h3 with its own anchor, such as "admin-users". */
interface HelpTopic {
	id: string;
	title: string;
	body: ReactNode;
}

/** One part of the Help page: an h2 and its topics, in reading order. */
export interface HelpPart {
	id: string;
	title: string;
	topics: HelpTopic[];
}
