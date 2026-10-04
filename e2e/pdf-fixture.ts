/** A one-page PDF with a line of text on it. */
export function pdf(): Buffer {
	const text = "BT /F1 24 Tf 40 100 Td (Assignment one) Tj ET";
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
		`<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
	];
	let out = "%PDF-1.4\n";
	const offsets: number[] = [];
	objects.forEach((object, index) => {
		offsets.push(out.length);
		out += `${index + 1} 0 obj\n${object}\nendobj\n`;
	});
	const xref = out.length;
	out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	out += offsets
		.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
		.join("");
	out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return Buffer.from(out, "latin1");
}
