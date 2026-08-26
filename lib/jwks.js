/**
 * Offline JWKS token validation for prefix-scoped external validators.
 *
 * A jwks validator entry ({realm_prefix, jwks_url, iss, aud}) verifies RS256
 * user tokens locally against the issuer's published JWKS instead of calling
 * a live auth endpoint per connection. Fail-closed by design: any fetch
 * problem simply means unknown kids stay unknown and their tokens are
 * rejected; already-cached keys keep working.
 *
 * Security notes:
 *  - the signature is verified before ANY claim is trusted;
 *  - tokens and key material are NEVER logged;
 *  - https is required for the JWKS endpoint, plain http only for loopback
 *    hosts (test rigs).
 */

'use strict';

const crypto = require('crypto');
const http = require('http');
const https = require('https');

const JWKS_REFETCH_COOLDOWN_MS = 60 * 1000;   // at most one fetch per minute
const JWKS_CACHE_TTL_MS = 60 * 60 * 1000;     // background refresh after 1h
const JWKS_CLOCK_SKEW_SECONDS = 30;           // allowed drift on exp/nbf
const JWKS_DEFAULT_MAX_TTL_SECONDS = 3600;    // max token lifetime (exp - iat)
const JWKS_FETCH_TIMEOUT_MS = 5 * 1000;
const JWKS_MAX_RESPONSE_BYTES = 64 * 1024;

const VALID_ROLES = ['producer', 'consumer', 'both'];

function isLoopbackHost(hostname) {
    return hostname === '127.0.0.1'
        || hostname === 'localhost'
        || hostname === '::1'
        || hostname === '[::1]';
}

function decodeBase64UrlJson(value) {
    value = value.replace(/-/g, '+').replace(/_/g, '/');
    while (value.length % 4)
        value += '=';
    return JSON.parse(Buffer.from(value, 'base64').toString('utf8'));
}

function decodeBase64Url(value) {
    return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/**
 * Create an offline validator for one jwks entry.
 *
 * @param {object} entry   {jwks_url, iss, aud} (realm_prefix scope is
 *                         enforced by the CALLER, exactly like live
 *                         validators — not duplicated here)
 * @param {object} options {logger} optional
 * @returns {{verify: function(string, number=): Promise<object|null>}}
 *          verify resolves {realm, role, sub, identity?} or null. `nowMs`
 *          defaults to Date.now(); tests pass explicit times to exercise
 *          cooldown/TTL behavior deterministically.
 */
function createJwksValidator(entry, options) {
    options = options || {};
    const logger = options.logger || console;
    const jwksUrl = String(entry.jwks_url || entry.jwksUrl || '');
    const expectedIss = String(entry.iss || '');
    const expectedAud = String(entry.aud || '');

    // Env override read once at construction.
    let maxTtlSeconds = parseInt(process.env.TYO_MQ_JWKS_MAX_TTL_SECONDS, 10);
    if (!Number.isFinite(maxTtlSeconds) || maxTtlSeconds <= 0)
        maxTtlSeconds = JWKS_DEFAULT_MAX_TTL_SECONDS;

    let cache = null;                  // {byKid: {kid → KeyObject}, fetchedAtMs}
    let lastFetchAttemptMs = -Infinity;
    let lastWarnMs = -Infinity;
    let inflightFetch = null;

    const warn = function (message, nowMs) {
        // One warning per cooldown window — a broken endpoint under token
        // load must not flood the log.
        if (nowMs - lastWarnMs < JWKS_REFETCH_COOLDOWN_MS)
            return;
        lastWarnMs = nowMs;
        if (logger && typeof logger.warn === 'function')
            logger.warn(message);
    };

    const requestJwks = function () {
        return new Promise(function (resolve, reject) {
            let parsed;
            try {
                parsed = new URL(jwksUrl);
            }
            catch (err) {
                return reject(new Error('invalid jwks_url'));
            }
            if (parsed.protocol !== 'https:'
                    && !(parsed.protocol === 'http:' && isLoopbackHost(parsed.hostname)))
                return reject(new Error('jwks_url must use https (http allowed for loopback only)'));

            const client = parsed.protocol === 'https:' ? https : http;
            const req = client.get(parsed, { timeout: JWKS_FETCH_TIMEOUT_MS }, function (res) {
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    res.resume();
                    return reject(new Error('JWKS fetch returned HTTP ' + res.statusCode));
                }
                let size = 0;
                const chunks = [];
                res.on('data', function (chunk) {
                    size += chunk.length;
                    if (size > JWKS_MAX_RESPONSE_BYTES) {
                        req.destroy();
                        return reject(new Error('JWKS response exceeds ' + JWKS_MAX_RESPONSE_BYTES + ' bytes'));
                    }
                    chunks.push(chunk);
                });
                res.on('end', function () {
                    try {
                        const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                        // Null prototype: token-supplied kids are used as
                        // lookup keys, so "constructor"/"__proto__" must not
                        // hit Object.prototype members (or set the prototype
                        // on assignment).
                        const byKid = Object.create(null);
                        (Array.isArray(data.keys) ? data.keys : []).forEach(function (jwk) {
                            if (!jwk || typeof jwk.kid !== 'string' || !jwk.kid)
                                return;
                            if (jwk.kty !== 'RSA')
                                return;
                            if (jwk.use && jwk.use !== 'sig')
                                return;
                            try {
                                byKid[jwk.kid] = crypto.createPublicKey({ key: jwk, format: 'jwk' });
                            }
                            catch (err) {
                                // Malformed key entries are skipped, not fatal.
                            }
                        });
                        resolve(byKid);
                    }
                    catch (err) {
                        reject(new Error('JWKS response is not valid JSON'));
                    }
                });
                res.on('error', reject);
            });
            req.on('timeout', function () {
                req.destroy(new Error('JWKS fetch timed out'));
            });
            req.on('error', reject);
        });
    };

    const fetchJwks = function (nowMs) {
        if (inflightFetch)
            return inflightFetch;
        lastFetchAttemptMs = nowMs;
        inflightFetch = requestJwks()
            .then(function (byKid) {
                cache = { byKid: byKid, fetchedAtMs: nowMs };
            })
            .catch(function (err) {
                // Fail closed: keep the previous cache; unknown kids stay
                // rejected until the endpoint recovers.
                warn('JWKS fetch failed for ' + jwksUrl + ': ' + (err && err.message), nowMs);
            })
            .finally(function () {
                inflightFetch = null;
            });
        return inflightFetch;
    };

    const verify = async function (token, nowMs) {
        if (typeof nowMs !== 'number')
            nowMs = Date.now();
        try {
            if (typeof token !== 'string')
                return null;
            const parts = token.split('.');
            if (parts.length !== 3)
                return null;

            const header = decodeBase64UrlJson(parts[0]);
            if (!header || header.alg !== 'RS256')
                return null;
            if (typeof header.kid !== 'string' || !header.kid)
                return null;

            // Key lookup: unknown kid → refetch, throttled by the cooldown.
            if (!cache || !cache.byKid[header.kid]) {
                if (nowMs - lastFetchAttemptMs >= JWKS_REFETCH_COOLDOWN_MS)
                    await fetchJwks(nowMs);
                else if (inflightFetch)
                    await inflightFetch;
            }
            else if (nowMs - cache.fetchedAtMs >= JWKS_CACHE_TTL_MS
                    && nowMs - lastFetchAttemptMs >= JWKS_REFETCH_COOLDOWN_MS) {
                // Background TTL refresh — current request keeps the old keys.
                fetchJwks(nowMs);
            }

            const key = cache && cache.byKid[header.kid];
            if (!key)
                return null;

            // Signature BEFORE any claim is trusted.
            const signedInput = Buffer.from(parts[0] + '.' + parts[1]);
            const signature = decodeBase64Url(parts[2]);
            if (!crypto.verify('RSA-SHA256', signedInput, key, signature))
                return null;

            const payload = decodeBase64UrlJson(parts[1]);
            if (!payload || typeof payload !== 'object')
                return null;

            const nowSec = Math.floor(nowMs / 1000);

            // exp REQUIRED; nbf honored; both with clock skew. All time
            // claims must be FINITE numbers — {exp: 1e999} JSON-parses to
            // Infinity and would otherwise turn the lifetime cap into NaN
            // comparisons (i.e. an eternal token).
            if (!Number.isFinite(payload.exp))
                return null;
            if (payload.exp <= nowSec - JWKS_CLOCK_SKEW_SECONDS)
                return null;
            if (payload.nbf !== undefined) {
                if (!Number.isFinite(payload.nbf))
                    return null;
                if (payload.nbf > nowSec + JWKS_CLOCK_SKEW_SECONDS)
                    return null;
            }

            // Lifetime cap — a misconfigured minter cannot issue
            // effectively-eternal user tokens. iat, when present, must be
            // finite and not in the future (beyond skew): a far-future iat
            // would otherwise slide the exp-iat window past the cap. The cap
            // is additionally enforced against NOW so no combination of
            // iat/exp yields a token valid longer than maxTtl from this
            // moment.
            if (payload.iat !== undefined) {
                if (!Number.isFinite(payload.iat))
                    return null;
                if (payload.iat > nowSec + JWKS_CLOCK_SKEW_SECONDS)
                    return null;
            }
            const iatBase = typeof payload.iat === 'number' ? payload.iat : nowSec;
            if (payload.exp - iatBase > maxTtlSeconds)
                return null;
            if (payload.exp - nowSec > maxTtlSeconds + JWKS_CLOCK_SKEW_SECONDS)
                return null;

            if (payload.iss !== expectedIss)
                return null;
            if (Array.isArray(payload.aud)) {
                if (payload.aud.indexOf(expectedAud) < 0)
                    return null;
            }
            else if (payload.aud !== expectedAud)
                return null;

            // Payload contract. The realm is returned for the caller's
            // prefix-scope check (same enforcement path as live validators).
            if (typeof payload.realm !== 'string' || !payload.realm)
                return null;
            if (VALID_ROLES.indexOf(payload.role) < 0)
                return null;
            if (typeof payload.sub !== 'string' || !payload.sub)
                return null;

            const result = {
                realm: payload.realm,
                role: payload.role,
                sub: payload.sub
            };
            if (payload.identity !== undefined) {
                if (typeof payload.identity !== 'string' || !payload.identity)
                    return null;
                result.identity = payload.identity;
            }
            return result;
        }
        catch (err) {
            return null;
        }
    };

    return { verify: verify };
}

module.exports = {
    createJwksValidator: createJwksValidator,
    isLoopbackHost: isLoopbackHost,
    JWKS_REFETCH_COOLDOWN_MS: JWKS_REFETCH_COOLDOWN_MS,
    JWKS_CACHE_TTL_MS: JWKS_CACHE_TTL_MS,
    JWKS_CLOCK_SKEW_SECONDS: JWKS_CLOCK_SKEW_SECONDS,
    JWKS_DEFAULT_MAX_TTL_SECONDS: JWKS_DEFAULT_MAX_TTL_SECONDS,
    JWKS_FETCH_TIMEOUT_MS: JWKS_FETCH_TIMEOUT_MS,
    JWKS_MAX_RESPONSE_BYTES: JWKS_MAX_RESPONSE_BYTES
};
