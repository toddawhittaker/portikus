const NUMBER = new Intl.NumberFormat("en-US");
const MONEY = new Intl.NumberFormat("en-US", {
	style: "currency",
	currency: "USD",
});

export function count(value: number): string {
	return NUMBER.format(value);
}

/** Codex reports no cost, so a missing one reads as a dash. */
export function cost(value: number | null): string {
	return value === null ? "—" : MONEY.format(value);
}
