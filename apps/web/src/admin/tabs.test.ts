import { expect, test } from "vitest";
import { ADMIN_TAB_GROUPS, ADMIN_TABS } from "./tabs.js";

test("the groups hold every admin tab once, in the strip's order", () => {
	expect(ADMIN_TAB_GROUPS.flatMap((group) => group.tabs)).toEqual([...ADMIN_TABS]);
});
