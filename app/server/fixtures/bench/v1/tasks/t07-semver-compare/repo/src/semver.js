// compareSemver(a, b) -> -1 | 0 | 1 for MAJOR.MINOR.PATCH[-prerelease] strings,
// following semver.org precedence rules (a prerelease sorts BEFORE its release;
// prerelease identifiers compare numerically when both are numeric, else lexically;
// a shorter prerelease list sorts first when all shared identifiers are equal).
export function compareSemver(a, b) {
  throw new Error('not implemented')
}
