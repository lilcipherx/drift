/**
 * GitHub App JSON Web Token (PRD §16.4). Signed RS256 with the app's private
 * key; used to exchange for a short-lived installation access token.
 */
export interface JwtHeader {
    alg: "RS256";
    typ: "JWT";
}
/**
 * Create a GitHub App JWT (max 10 minutes TTL per GitHub docs).
 * Returns a compact JWT string: `header.payload.signature`.
 */
export declare function createAppJwt(appId: string, privateKeyPem: string, ttlSeconds?: number): string;
/** Decode (without verifying) a JWT for debugging/tests. */
export declare function decodeJwt<T>(token: string): {
    header: JwtHeader;
    payload: T;
};
//# sourceMappingURL=jwt.d.ts.map