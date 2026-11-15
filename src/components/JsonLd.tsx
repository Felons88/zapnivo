/**
 * Server component that renders a JSON-LD structured-data block.
 * JSON.stringify output is made safe for inline <script> by escaping "<"
 * (prevents a literal "</script>" inside any string from closing the tag).
 */
export function JsonLd({ data }: { data: object }) {
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: json }} />;
}
