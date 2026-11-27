/**
 * POSIX single-quoting for values embedded in a generated bash script.
 *
 * Public issue #160: session env values were rendered as `export KEY=<value>`
 * with the value run through `JSON.stringify`, i.e. double-quoted. Bash still
 * expands `$…`, `` `…` `` and `\…` inside double quotes, so a secret such as
 * `Tr0ub4dor$3x!` lost its `$3` on the way in, `$(...)`/backticks inside a
 * value executed as a command when the wrapper started, and a multi-line
 * value (e.g. a PEM key) arrived as a literal `\n` instead of a real newline.
 * Single-quoting is inert to all of that — bash performs no expansion at all
 * inside single quotes, and a real newline inside single quotes is preserved
 * literally.
 */

/** Single-quote `value` for safe, literal inclusion in a bash script. */
export function shellSingleQuote(value: string): string {
  return `'${value.split('\'').join(`'\\''`)}'`
}

/**
 * Render `export KEY=<value>` lines (one per entry, newline-joined) for a
 * bash wrapper script, with every value single-quoted so it reaches the
 * session byte-for-byte regardless of `$`, backticks, quotes, backslashes or
 * embedded newlines.
 */
export function renderEnvExports(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([k, v]) => `export ${k}=${shellSingleQuote(v)}`)
    .join('\n')
}
