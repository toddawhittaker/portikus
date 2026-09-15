import type { HealthResponse } from "@portikus/contracts";
import { useEffect, useState } from "react";

/** The single page of the P0 shell. It shows the product name and the API health. */
export function Home() {
	const [health, setHealth] = useState<HealthResponse | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		fetch("/health")
			.then((response) => response.json())
			.then((body: HealthResponse) => {
				if (!cancelled) setHealth(body);
			})
			.catch(() => {
				if (!cancelled) setError("API unavailable");
			});
		return () => {
			cancelled = true;
		};
	}, []);

	return (
		<main>
			<h1>Portikus</h1>
			<p data-testid="health">
				{health ? `api: ${health.status}` : (error ?? "checking api...")}
			</p>
		</main>
	);
}
