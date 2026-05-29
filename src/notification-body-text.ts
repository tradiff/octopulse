export function normalizeNotificationBodyText(bodyText: string): string {
  const normalizedLines = stripRichText(bodyText)
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s*\|\s*/g, " ").replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0)
    .filter((line) => !/^[|:\-\s]+$/.test(line))
    .filter((line) => !/^(?:[-*_]\s*){3,}$/.test(line));

  return normalizedLines.join(" ");
}

function stripRichText(bodyText: string): string {
  return decodeHtmlEntities(
    bodyText
      .replace(/(^|\n)(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n\2(?=\n|$)/g, "\n")
      .replace(/<!--[\s\S]*?-->/g, "\n")
      .replace(/!\[([^\]]*)\]\([^\)]*\)/g, " $1 ")
      .replace(/\[([^\]]+)\]\([^\)]*\)/g, " $1 ")
      .replace(/<img\b[^>]*\balt=(['"])(.*?)\1[^>]*\/?>/gi, " $2 ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<li\b[^>]*>/gi, "\n- ")
      .replace(/<\/?(?:details|summary|p|div|section|article|header|footer|aside|table|thead|tbody|tfoot|tr|th|td|ul|ol|pre|blockquote|h[1-6]|sub)\b[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/^\s{0,3}#{1,6}\s+/gm, "")
      .replace(/^\s{0,3}>\s?/gm, "")
      .replace(/^\s*[-*+]\s+\[[ xX]\]\s+/gm, "")
      .replace(/^\s*[-*+]\s+/gm, "")
      .replace(/^\s*\d+\.\s+/gm, "")
      .replace(/\[!([A-Z]+)\]/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/__([^_]+)__/g, "$1")
      .replace(/~~([^~]+)~~/g, "$1"),
  );
}

function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (_match, entity: string) =>
    decodeHtmlEntity(entity),
  );
}

function decodeHtmlEntity(entity: string): string {
  switch (entity) {
    case "amp":
      return "&";
    case "lt":
      return "<";
    case "gt":
      return ">";
    case "quot":
      return '"';
    case "apos":
    case "#39":
      return "'";
    case "nbsp":
      return " ";
    default:
      break;
  }

  const numericEntity = entity.startsWith("#x")
    ? Number.parseInt(entity.slice(2), 16)
    : entity.startsWith("#")
      ? Number.parseInt(entity.slice(1), 10)
      : Number.NaN;

  return Number.isFinite(numericEntity) ? String.fromCodePoint(numericEntity) : `&${entity};`;
}
