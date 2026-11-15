# duration

`parseDuration(input: string): number` returns the number of SECONDS in a duration
string made of one or more `<integer><unit>` parts, units `d`, `h`, `m`, `s`, in that
order, each at most once (`"1h30m"`, `"2d"`, `"45s"`, `"1d2h3m4s"`).
Anything else (empty string, unknown unit, repeated or out-of-order unit, decimals,
whitespace) throws a `RangeError`.
