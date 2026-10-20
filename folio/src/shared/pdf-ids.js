// Annotation ids in the pdf.js format: "<num>R" for generation 0, otherwise "<num>R<gen>".
// pdf.js builds them the same way (see Ref.toString in pdf.js), so ids from
// PDFPageProxy.getAnnotations() match the ids the engine derives from pdf-lib refs.

export function annotId(num, gen = 0) {
  return gen === 0 ? `${num}R` : `${num}R${gen}`;
}

/** Parses "<num>R" / "<num>R<gen>" into {num, gen}; returns null for anything else. */
export function parseAnnotId(id) {
  const m = /^(\d+)R(\d*)$/.exec(String(id ?? ''));
  if (!m) return null;
  return { num: Number(m[1]), gen: m[2] === '' ? 0 : Number(m[2]) };
}
