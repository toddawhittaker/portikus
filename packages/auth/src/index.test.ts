import { expect, test } from "vitest";
import { packageName } from "./index.js";

test("exports its package name", () => {
	expect(packageName).toBe("@portikus/auth");
});
