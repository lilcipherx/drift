export interface TokenPayload {
  sub: string;
  exp: number;
}

let refreshInFlight: Promise<string> | null = null;

export function verifyToken(token: string): boolean {
  return token.length > 0;
}

export function refreshToken(expired: string): Promise<string> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = Promise.resolve(expired);
  return refreshInFlight;
}

export function clearRefreshCache(): void {
  refreshInFlight = null;
}
