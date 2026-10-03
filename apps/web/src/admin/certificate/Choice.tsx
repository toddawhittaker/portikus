/** A radio group with a sentence under each choice, as the egress entry dialog has. */
export function Choice<T extends string>({
	legend,
	name,
	value,
	choices,
	onChange,
}: {
	legend: string;
	name: string;
	value: T;
	choices: { value: T; label: string; text: string }[];
	onChange: (value: T) => void;
}) {
	return (
		<fieldset className="m-0 grid content-start gap-2 border-0 p-0">
			<legend className="mb-2 p-0 font-medium text-[13px] text-ink">{legend}</legend>
			{choices.map((choice) => {
				const id = `${name}-${choice.value}`;
				// The whole row stays clickable; the name is the short label, the sentence its description.
				return (
					<label key={choice.value} className="flex items-start gap-2 text-[13px]">
						<input
							type="radio"
							name={name}
							className="pk-focus-ring mt-0.5"
							checked={value === choice.value}
							data-testid={id}
							aria-labelledby={`${id}-label`}
							aria-describedby={`${id}-text`}
							onChange={() => onChange(choice.value)}
						/>
						<span>
							<span id={`${id}-label`}>{choice.label}</span>
							<span className="block text-ink-muted" id={`${id}-text`}>
								{choice.text}
							</span>
						</span>
					</label>
				);
			})}
		</fieldset>
	);
}
