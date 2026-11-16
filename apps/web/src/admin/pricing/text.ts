import {
	type AdminModelPrice,
	type ModelPrice,
	type PriceProposal,
	type PriceProvider,
	PriceRowInput,
	type PriceRun,
} from "@portikus/contracts";

export const PROVIDER_LABEL: Record<PriceProvider, string> = {
	anthropic: "Anthropic",
	openai: "OpenAI",
};

const DOLLARS = new Intl.NumberFormat("en", {
	style: "currency",
	currency: "USD",
	minimumFractionDigits: 2,
	maximumFractionDigits: 4,
});
const NUMBER = new Intl.NumberFormat("en", { maximumFractionDigits: 4 });
const DATE = new Intl.DateTimeFormat("en", { dateStyle: "medium" });
const DATE_TIME = new Intl.DateTimeFormat("en", {
	dateStyle: "medium",
	timeStyle: "short",
});

export function dollars(n: number): string {
	return DOLLARS.format(n);
}

/** A multiple of the input price, such as "0.1×". */
export function ratio(n: number | null): string {
	return n === null ? "None" : `${NUMBER.format(n)}×`;
}

export function lifetime(seconds: number): string {
	if (seconds % 3600 === 0) return `${seconds / 3600} h`;
	if (seconds % 60 === 0) return `${seconds / 60} min`;
	return `${seconds} s`;
}

export function surcharge(
	row: Pick<ModelPrice, "surchargeAboveTokens" | "surchargeFactor">,
) {
	if (row.surchargeAboveTokens === null || row.surchargeFactor === null) return "None";
	return `${NUMBER.format(row.surchargeFactor)}× past ${NUMBER.format(row.surchargeAboveTokens)} tokens`;
}

export function day(iso: string): string {
	return DATE.format(new Date(iso));
}

export function when(iso: string): string {
	return DATE_TIME.format(new Date(iso));
}

export function hostOf(address: string): string {
	try {
		return new URL(address).hostname.toLowerCase();
	} catch {
		return address;
	}
}

/** What went wrong with one source, per the run's `host:code` list (SPEC.md section 20.4). */
const SOURCE_ERRORS: Record<string, string> = {
	refused:
		"The page refused the request, or the server proxy does not allow its host. Allow the host under Sources, or edit the rows by hand.",
	unreachable:
		"The server could not reach the page. Check the address, and that the server proxy allows its host.",
	"too-large": "The page was too large to read.",
	"bad-redirect": "The page redirected somewhere Portikus does not follow.",
	timeout: "The page took too long to answer.",
	"unknown-provider":
		"Portikus cannot tell whose prices this page lists. Use an OpenAI or Anthropic pricing page.",
	"no-rows": "The model read the page but found no prices on it.",
	"model-failed":
		"The model could not turn the page into price rows. Try again, or edit the rows by hand.",
};

/** A run's failure with no source: the server restarted, or something broke inside it. */
const RUN_ERRORS: Record<string, string> = {
	interrupted: "The check was cut off when the server restarted. Run it again.",
	internal: "The check stopped on an internal error. Run it again.",
};

/** The address a "moved=<encoded url>" code names, or null when it is cut off or not https. */
function movedTarget(code: string): URL | null {
	try {
		const url = new URL(decodeURIComponent(code.slice("moved=".length)));
		return url.protocol === "https:" ? url : null;
	} catch {
		return null;
	}
}

export interface SourceFailure {
	host: string | null;
	code: string;
	text: string;
	/** The page offers to allow the host on the server proxy. */
	proxy: boolean;
}

export function runFailures(errorCode: string | null): SourceFailure[] {
	if (!errorCode) return [];
	return errorCode.split(",").map((part): SourceFailure => {
		const at = part.lastIndexOf(":");
		if (at < 0) {
			const text = RUN_ERRORS[part] ?? "The check failed. Run it again.";
			return { host: null, code: part, text, proxy: false };
		}
		const code = part.slice(at + 1);
		if (code.startsWith("moved=")) {
			const to = movedTarget(code);
			const text = to
				? `The page moved to ${to.hostname}, which the server proxy does not allow. Change this source to ${to.href}, or allow ${to.hostname}.`
				: "The page moved to an address the server proxy does not allow. Change this source to the new address, or allow its host.";
			return { host: part.slice(0, at), code: "moved", text, proxy: true };
		}
		return {
			host: part.slice(0, at),
			code,
			text: SOURCE_ERRORS[code] ?? "Portikus could not read this page.",
			proxy: code === "refused" || code === "unreachable",
		};
	});
}

export const STATUS_LABEL: Record<PriceRun["status"], string> = {
	running: "Running",
	done: "Done",
	failed: "Failed",
};
export const TRIGGER_LABEL: Record<PriceRun["trigger"], string> = {
	manual: "Run by hand",
	weekly: "Weekly check",
};

/** The fields a proposal can change, in the order the diff lists them. */
export const DIFF_FIELDS: readonly {
	key: string;
	label: string;
	show: (row: ModelPrice | PriceProposal) => string;
}[] = [
	{
		key: "input",
		label: "Input per million",
		show: (r) => dollars(r.inputPricePerMillion),
	},
	{ key: "read", label: "Cache read", show: (r) => ratio(r.cacheReadRatio) },
	{ key: "write", label: "Cache write", show: (r) => ratio(r.cacheWriteRatio) },
	{
		key: "write-hour",
		label: "One-hour cache write",
		show: (r) => ratio(r.cacheWriteOneHourRatio),
	},
	{ key: "ttl", label: "Cache lifetime", show: (r) => lifetime(r.cacheTtlSeconds) },
	{ key: "surcharge", label: "Surcharge", show: surcharge },
	{ key: "source", label: "Source", show: (r) => r.sourceUrl },
];

/** The listed hosts from GET /admin/proxy-hosts, as the API counts them: port 443 or no port. */
export function listedHosts(lists: string[][]): Set<string> {
	return new Set(
		lists.flat().flatMap((entry) => {
			const host = entry.toLowerCase();
			if (!host.includes(":")) return [host];
			return host.endsWith(":443") ? [host.slice(0, -4)] : [];
		}),
	);
}

/** Hosts of the source addresses the server proxy does not list, for the D5 offer. */
export function unlistedSourceHosts(
	sources: string[],
	listed: Set<string> | null,
): string[] {
	if (!listed) return [];
	const hosts = sources.flatMap((s) => {
		try {
			return [new URL(s).hostname.toLowerCase()];
		} catch {
			return [];
		}
	});
	return [...new Set(hosts)].filter((h) => !listed.has(h));
}

/** The row dialog's fields, as text the person types. */
export interface RowDraft {
	provider: PriceProvider;
	model: string;
	inputPricePerMillion: string;
	cacheReadRatio: string;
	cacheWriteRatio: string;
	cacheWriteOneHourRatio: string;
	cacheTtlSeconds: string;
	surchargeAboveTokens: string;
	surchargeFactor: string;
	sourceUrl: string;
	sourceQuote: string;
}
export type DraftField = keyof RowDraft;

export function draftOf(row: AdminModelPrice | null): RowDraft {
	const text = (n: number | null) => (n === null ? "" : String(n));
	return {
		provider: row?.provider ?? "anthropic",
		model: row?.model ?? "",
		inputPricePerMillion: text(row?.inputPricePerMillion ?? null),
		cacheReadRatio: text(row?.cacheReadRatio ?? null),
		cacheWriteRatio: text(row?.cacheWriteRatio ?? null),
		cacheWriteOneHourRatio: text(row?.cacheWriteOneHourRatio ?? null),
		cacheTtlSeconds: text(row?.cacheTtlSeconds ?? 300),
		surchargeAboveTokens: text(row?.surchargeAboveTokens ?? null),
		surchargeFactor: text(row?.surchargeFactor ?? null),
		sourceUrl: row?.sourceUrl ?? "",
		sourceQuote: row?.sourceQuote ?? "",
	};
}

const FIELD_ERRORS: Partial<Record<DraftField, string>> = {
	model: "Give the model's name, or the part of its id every version shares.",
	inputPricePerMillion:
		"Give the price in US dollars per million input tokens, above 0.",
	cacheReadRatio: "Give a multiple above 0 and at most 1, such as 0.1.",
	cacheWriteRatio: "Give a multiple above 0 and at most 10, such as 1.25.",
	cacheWriteOneHourRatio: "Give a multiple above 0 and at most 10, or leave it empty.",
	cacheTtlSeconds: "Give whole seconds, from 1 to 86400.",
	surchargeAboveTokens:
		"Give a whole number of tokens, or leave both surcharge fields empty.",
	surchargeFactor:
		"Give a multiple above 1 and at most 10, or leave both surcharge fields empty.",
	sourceUrl: "Give the pricing page's https:// address, by host name.",
	sourceQuote: "Paste the sentence or table cell the price comes from.",
};

function number(text: string): number | null {
	const clean = text.trim().replace(/[$,_\s]/g, "");
	return clean === "" ? null : Number(clean);
}

/** The row to send, or the message for each field the contract refuses. */
export function parseDraft(
	draft: RowDraft,
): { row: PriceRowInput } | { errors: Partial<Record<DraftField, string>> } {
	const candidate = {
		provider: draft.provider,
		model: draft.model,
		inputPricePerMillion: number(draft.inputPricePerMillion),
		cacheReadRatio: number(draft.cacheReadRatio),
		cacheWriteRatio: number(draft.cacheWriteRatio),
		cacheWriteOneHourRatio: number(draft.cacheWriteOneHourRatio),
		cacheTtlSeconds: number(draft.cacheTtlSeconds),
		surchargeAboveTokens: number(draft.surchargeAboveTokens),
		surchargeFactor: number(draft.surchargeFactor),
		sourceUrl: draft.sourceUrl,
		sourceQuote: draft.sourceQuote,
	};
	const parsed = PriceRowInput.safeParse(candidate);
	if (parsed.success) return { row: parsed.data };
	const errors: Partial<Record<DraftField, string>> = {};
	for (const issue of parsed.error.issues) {
		const field = issue.path[0] as DraftField | undefined;
		if (field && field in FIELD_ERRORS) errors[field] ??= FIELD_ERRORS[field];
		else {
			// The surcharge rule names no field: mark the empty one.
			const missing =
				candidate.surchargeAboveTokens === null
					? "surchargeAboveTokens"
					: "surchargeFactor";
			errors[missing] ??= "Give both surcharge figures, or leave both empty.";
		}
	}
	return { errors };
}
