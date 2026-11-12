/**
 * The portico of the Portikus mark as a line drawing, for page eyebrows and
 * quiet states. `clear` puts a tick in the pediment, `empty` dashes the
 * columns; both are decorative, so the words beside it carry the meaning.
 */
export function PorticoMark({
	variant = "plain",
	size = 16,
}: {
	variant?: "plain" | "clear" | "empty";
	size?: 16 | 24;
}) {
	return (
		<svg
			className="pk-portico"
			data-variant={variant}
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			aria-hidden={true}
			focusable={false}
		>
			<path className="pk-portico-roof" d="M3 9 12 3.5 21 9z" />
			<path
				className="pk-portico-cols"
				d="M6.5 11.5v6.5M10 11.5v6.5M14 11.5v6.5M17.5 11.5v6.5"
				strokeDasharray={variant === "empty" ? "2 1.6" : undefined}
			/>
			<path className="pk-portico-base" d="M3.5 20.5h17" />
			{variant === "clear" ? (
				<path className="pk-portico-tick" d="m9.6 7.1 1.6 1.4 3.2-3" />
			) : null}
		</svg>
	);
}
