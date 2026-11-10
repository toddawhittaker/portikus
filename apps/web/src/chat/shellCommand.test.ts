import { expect, test } from "vitest";
import { isShellCommand, shellCommandText } from "./shellCommand";

test.each([
	["!ls", true],
	["! ls -la", true],
	["   !pwd", true],
	["\n\t!echo hi", true],
	["!!", true],
	["!", false],
	["!   ", false],
	["  !  \n", false],
	["", false],
	["   ", false],
	["ls !", false],
	["hello !ls", false],
	["/help", false],
])("isShellCommand(%j) is %s", (text, expected) => {
	expect(isShellCommand(text)).toBe(expected);
});

test.each([
	["!ls", "ls"],
	["! ls -la ", "ls -la"],
	["  !pwd", "pwd"],
	["!echo a\n  b", "echo a\n  b"],
	["!!", "!"],
])("shellCommandText(%j) is %j", (text, expected) => {
	expect(shellCommandText(text)).toBe(expected);
});
