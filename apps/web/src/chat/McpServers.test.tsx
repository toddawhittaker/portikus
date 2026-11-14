import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { McpServers } from "./McpServers";

afterEach(cleanup);

test("a long server name is shown whole, to wrap, never cut off with a title to hover", () => {
	const name = "an-extremely-long-mcp-server-name-that-would-not-fit-in-a-narrow-pane";
	render(
		<McpServers
			servers={[{ name, status: "connected" }]}
			agent="codex"
			expanded={true}
			onExpandedChange={() => undefined}
		/>,
	);
	const row = within(screen.getByRole("region", { name: "MCP servers" })).getByRole(
		"listitem",
	);
	const shown = within(row).getByText(name);
	expect(shown.hasAttribute("title")).toBe(false);
});
