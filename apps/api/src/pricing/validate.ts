import { type PriceProvider, PriceRowInput } from "@portikus/contracts";

/** The name of the only tool the price check model is given. */
export const SUBMIT_ROWS_TOOL = "submit_rows";

const PROVIDER_HOSTS: Record<PriceProvider, string[]> = {
	anthropic: ["anthropic.com", "claude.com"],
	openai: ["openai.com"],
};

/** Whose prices a source page lists, from its host; null for an unknown host. */
export function providerOfSource(url: string): PriceProvider | null {
	const host = new URL(url).hostname.toLowerCase();
	for (const [provider, hosts] of Object.entries(PROVIDER_HOSTS)) {
		if (hosts.some((h) => host === h || host.endsWith(`.${h}`)))
			return provider as PriceProvider;
	}
	return null;
}

export type RowCheck = { rows: PriceRowInput[]; errors: string[] };

const collapse = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * Check what the model submitted for one source: the contract shape, the
 * source's provider, and a quote that appears word for word in the page
 * text, so a figure cannot be made up. The source address is the page
 * fetched, whatever the model wrote. Errors name fields, never page text.
 */
export function checkRows(
	input: unknown,
	source: { url: string; provider: PriceProvider; text: string },
): RowCheck {
	const rows = (input as { rows?: unknown } | null)?.rows;
	if (!Array.isArray(rows) || rows.length === 0) {
		return { rows: [], errors: ["Give { rows: [...] } with at least one row."] };
	}
	const out: PriceRowInput[] = [];
	const errors: string[] = [];
	rows.forEach((raw, index) => {
		const candidate =
			raw && typeof raw === "object" ? { ...raw, sourceUrl: source.url } : raw;
		const parsed = PriceRowInput.safeParse(candidate);
		if (!parsed.success) {
			const fields = [
				...new Set(parsed.error.issues.map((i) => i.path.join(".") || i.message)),
			];
			errors.push(`Row ${index + 1}: check ${fields.join(", ")}.`);
			return;
		}
		const row = parsed.data;
		if (row.provider !== source.provider) {
			errors.push(
				`Row ${index + 1}: provider must be ${source.provider} for this page.`,
			);
			return;
		}
		if (!source.text.includes(collapse(row.sourceQuote))) {
			errors.push(`Row ${index + 1}: sourceQuote is not text from the page.`);
			return;
		}
		out.push({ ...row, sourceQuote: collapse(row.sourceQuote) });
	});
	return { rows: out, errors };
}
