// Parses CSV text into an array of rows (arrays of strings).
// BUG: does not handle quoted fields ("a,b" or "say ""hi""").
export function parseCsv(text) {
  return text
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => line.split(','))
}
