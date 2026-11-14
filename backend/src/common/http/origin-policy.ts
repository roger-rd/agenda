export interface OriginInput { origin: unknown; secFetchSite: unknown; allowed: readonly string[] }
export function originDenialReason({ origin, secFetchSite, allowed }: OriginInput): string | undefined {
  if (origin !== undefined) {
    if (origin === 'null') return 'origin_null';
    if (typeof origin !== 'string' || !origin || origin.includes(',')) return 'origin_malformed';
    try {
      const url = new URL(origin);
      if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin) return 'origin_malformed';
    } catch { return 'origin_malformed'; }
    return allowed.includes(origin) ? undefined : 'origin_not_allowed';
  }
  return secFetchSite === undefined || secFetchSite === 'same-origin' || secFetchSite === 'none'
    ? undefined : 'site_not_allowed';
}
export function checkOrigin(input: OriginInput): 'allow' | 'deny' {
  return originDenialReason(input) === undefined ? 'allow' : 'deny';
}
