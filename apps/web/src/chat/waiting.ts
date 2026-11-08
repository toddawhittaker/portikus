/** How many more cards wait behind the one shown. */
export function waitingText(waiting: number): string {
	return waiting === 1
		? "1 more request is waiting."
		: `${waiting} more requests are waiting.`;
}
