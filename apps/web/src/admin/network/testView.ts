import { type AdminEgressView, EGRESS_PRESETS } from "@portikus/contracts";

/** An allow-list policy with GitHub on, one host and one range, applied. For tests. */
export function egressView(overrides: Partial<AdminEgressView> = {}): AdminEgressView {
	return {
		version: 3,
		mode: "allow-list",
		presets: ["github"],
		ports: [22, 80, 443],
		entries: [
			{
				id: "11111111-1111-4111-8111-111111111111",
				kind: "host",
				value: "api.example.edu",
				label: "Course API",
				createdAt: "2026-09-27T10:00:00.000Z",
				updatedAt: "2026-09-27T10:00:00.000Z",
			},
			{
				id: "22222222-2222-4222-8222-222222222222",
				kind: "range",
				value: "203.0.113.0/24",
				label: "",
				createdAt: "2026-09-27T10:00:00.000Z",
				updatedAt: "2026-09-27T10:00:00.000Z",
			},
		],
		presetCatalog: EGRESS_PRESETS.map((p) => ({
			id: p.id,
			label: p.label,
			hosts: [...p.hosts],
		})),
		apply: { appliedVersion: 3, appliedAt: "2026-09-27T10:00:00.000Z", error: null },
		blockedSites: [
			{
				id: "44444444-4444-4444-8444-444444444444",
				value: "dns.google",
				label: "DNS over HTTPS service (default)",
				createdAt: "2026-09-27T10:00:00.000Z",
				updatedAt: "2026-09-27T10:00:00.000Z",
			},
			{
				id: "55555555-5555-4555-8555-555555555555",
				value: "games.example.com",
				label: "Games",
				createdAt: "2026-09-27T10:00:00.000Z",
				updatedAt: "2026-09-27T10:00:00.000Z",
			},
		],
		blocked: [],
		...overrides,
	};
}
