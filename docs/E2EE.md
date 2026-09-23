# End-to-end encrypted payloads (design — target 0.18.0)

**Status:** design / proposal. Opt-in, backwards-compatible, like every tyo-mq
feature. This document defines the wire format, crypto, key discovery, client
API, and trust model precisely enough to implement across every client language
against shared conformance vectors.

## Goal

Let a producer encrypt a message's **payload** so that only the intended
consumer(s) can read it — the broker and any other bus participant see only
ciphertext. Do it **generically in the client library**, so any application on
tyo-mq gets it by flagging a message, and both ends "just know what to do" when
they are E2EE-ready.

## Non-goals / honest limits

- **Not hiding metadata.** `event`/topic, `to`, `from`, timing, and message size
  stay cleartext — the broker routes on them. E2EE hides *what*, not *that* or
  *to whom*.
- **The broker never decrypts.** It relays ciphertext and, optionally, hosts a
  directory of **public** keys. It holds no private key and cannot read payloads.
- **The library does not invent trust.** It provides the mechanism + interfaces;
  *who to trust* (pinning / fingerprints) is the integrator's decision (see
  Trust model). A naive "trust the broker's key directory" is MITM-able.

## Trust boundaries

| Party | Sees | Can decrypt? |
|---|---|---|
| Broker | routing metadata, ciphertext, **public** keys | **no** |
| Other bus participants | same as broker | no |
| Intended consumer | everything | yes (holds the private key) |
| A compromised consumer | its own traffic only | its own only |

## The encrypted message envelope

An encrypted message extends the normal produced message (`{event, message,
from, to, …}`): routing stays cleartext, `message` becomes ciphertext, and an
`enc` block describes how to open it.

```json
{
  "event": "command",              // cleartext — broker routes on it
  "to":    "dev-1",                // cleartext — recipient selector
  "from":  "op-console",           // cleartext
  "enc": {
    "v":   1,
    "alg": "ecdh-es-p256-a256gcm",
    "epk": "<base64 uncompressed ephemeral public key, 65 bytes>",
    "iv":  "<base64 12-byte GCM nonce>",
    "kid": "<recipient key id the sender encrypted to>"
  },
  "message": "<base64 AES-GCM ciphertext||tag>"
}
```

- `enc` **present** ⇒ the consuming library opens `message` before handing the
  plaintext to the app handler.
- `enc` **absent** ⇒ cleartext, exactly as today (fully backwards-compatible,
  opportunistic).

Because `message` is now a base64 **string**, it survives the broker's JSON
relay byte-for-byte — so encryption needs **no canonical serialization** (unlike
signing). The only things that must match across languages are the KDF, the AAD
construction, and the point/nonce encodings, all defined below.

## Default crypto: `ecdh-es-p256-a256gcm` (ECIES)

Forward-secret per message (ephemeral sender key), recipient needs only a
published **static** public key.

**Seal (sender), given recipient static public key `R`:**
1. Generate an ephemeral P-256 keypair `(e, E)`. `epk = uncompressed(E)` (65 bytes).
2. `Z = ECDH(e, R)`; take `x = X-coordinate(Z)` as 32 big-endian bytes.
3. `K = HKDF-SHA256(ikm = x, salt = "" (empty), info = utf8("tyo-mq-e2ee-v1:" + alg + ":" + kid), L = 32)`.
4. `iv = 12 random bytes`.
5. `aad = utf8(event + "\n" + (to || "") + "\n" + (from || ""))` — binds the
   ciphertext to its routing so it can't be cut-and-pasted onto another envelope.
6. `ct = AES-256-GCM.Seal(K, iv, plaintext, aad)` where `plaintext` = the raw
   bytes the app produced (e.g. `utf8(JSON.stringify(data))`).
7. Emit `enc = {v:1, alg, epk, iv, kid}`, `message = base64(ct)`.

**Open (recipient), given its private key `r` for `kid`:**
1. `Z = ECDH(r, E)`; `x = X-coordinate(Z)`.
2. `K = HKDF-SHA256(...)` — identical to seal.
3. `plaintext = AES-256-GCM.Open(K, iv, ct, aad)`; GCM's tag authenticates it.
4. Hand `plaintext` (parsed back to the app's data type) to the consume handler.

All of Node `crypto` (`createECDH('prime256v1')`, `hkdfSync`,
`createCipheriv('aes-256-gcm')`), Go `crypto/ecdh` + `crypto/hkdf` +
`crypto/cipher`, and browser WebCrypto (`ECDH P-256`, `HKDF`, `AES-GCM`) support
this identically. `alg` is a negotiable field so a future suite (e.g. X25519,
hybrid PQ) is additive.

## Key discovery + the public-key directory (broker-hosted, optional)

Public keys are not secret, so the broker MAY host a directory purely to answer
"is this peer E2EE-ready, and what's its key?" — opportunistic-encryption with
discovery, à la STARTTLS.

- `KEY_PUBLISH { key_id, alg, public_key }` — a client registers its **public**
  key (scoped to its realm + identity/name). Idempotent; upsert.
- `KEY_LOOKUP { identity }` → `{ keys: [{ key_id, alg, public_key }] }`.
- On register/announce a client sets `e2ee: true`; the broker includes it in the
  producer/consumer online metadata so peers can tell.

**Policy (per realm):** `e2ee: "off" | "opportunistic" | "required"`.
- `opportunistic`: encrypt when the recipient's key is known; else cleartext.
- `required`: refuse to produce/accept an unencrypted message on the realm.

## Client API

Additive; existing calls unchanged.

**Produce:**
```js
producer.produce("command", data, { encrypt: true });          // encrypt to `to`
producer.produce("command", data, { encryptTo: "dev-1" });     // explicit recipient
```
When `encrypt`/`encryptTo` is set, the library resolves the recipient key via the
`KeyResolver`, seals per the suite, and sends the `enc` envelope. Without a
resolvable key it applies the realm policy (skip / throw).

**Consume:** automatic. When a delivered message carries `enc`, the library opens
it with the local private key for `enc.kid` and passes **plaintext** to the
existing `onConsume(message, from, ack)` handler. Undecryptable ⇒ per-policy
(drop + warn, or surface an error).

**Pluggable interfaces (the app implements the top one):**
```
KeyResolver:                        // WHERE keys live + WHO to trust (app-owned)
  myPrivateKey(kid)      -> priv    // this client's private key for kid
  peerPublicKey(identity)-> { kid, alg, publicKey }   // pinned or directory-looked-up

CryptoProvider:                     // HOW to seal/open (default provided)
  seal(recipientPub, aad, plaintext) -> { epk, iv, ct }
  open(myPriv, epk, iv, ct, aad)     -> plaintext
```
The default `CryptoProvider` is `ecdh-es-p256-a256gcm`. The default `KeyResolver`
can front the broker directory for low-assurance apps; a security-sensitive
integrator supplies its own (pinned) resolver.

## Trust model — the directory is discovery, not a trust anchor

If the broker serves the public keys, a malicious broker can substitute a key it
controls and MITM. So identity trust is anchored **outside** the broker, at the
`KeyResolver`. Two levels:

- **Pinned** (e.g. tyoman): keys are pinned at enrollment via the integrator's
  own registry; the broker directory is convenience only, never trusted for
  identity.
- **Fingerprint-verified** (e.g. a chat app): show a safety-number/emoji
  fingerprint of the resolved key for out-of-band confirmation.

Both are just `KeyResolver` implementations; the wire format and crypto are the
same.

## Broadcast / group messages (decision needed)

`produce(..., {broadcast, encrypt})` has no single recipient. Options:
1. **Per-recipient fan-out seal** — the library seals once per online subscriber
   key (N `enc` blocks or N sends). Simple, no shared secret, scales poorly.
2. **Realm/group shared key** — a symmetric key distributed to group members
   out-of-band (like a chatroom passphrase); one seal for all. Scales, but a
   member compromise leaks the group.
Recommend shipping 1:1 (`to`) first; group E2EE as a follow-up with the shared-key
option behind the same `enc` format (`alg: "aeskw-a256gcm"` group variant).

## What the broker does / doesn't

- **Does:** relay the `enc` envelope unchanged; route on `event`/`to` as always;
  optionally host the public-key directory; enforce realm `e2ee` policy
  (reject cleartext on a `required` realm) — all on metadata only.
- **Doesn't:** read, decrypt, hold private keys, or re-serialize `message`
  (it's an opaque string). Durable delivery / DLQ store the ciphertext as-is.

## Cross-language conformance

Ship a committed vector file (`e2ee-vectors.json`): fixed recipient keypair,
fixed ephemeral key, fixed plaintext + routing → expected `epk`, `iv`, KDF
output, `aad`, and ciphertext. Every client (Node, Go, browser, Python, …)
must (a) open the committed ciphertext, and (b) reproduce the KDF/AAD bytes.
Same discipline as the admin-signature/cmdsign vectors. This is the real work.

## Versioning, config, docs

- **tyo-mq 0.18.x**, opt-in. A realm turns it on with
  `realms.<id>.e2ee: opportunistic|required`; default `off` → no change.
- Wiki page **E2EE Payloads** on ship; README client-library note; the
  cross-language conformance suite gains the E2EE vectors.
- No admin/broker key changes — E2EE is orthogonal to auth/realms/signing.

## How integrators use it

- **tyoman (RMM):** device + operator ECDH keypairs are registered at enrollment
  (pinned). Its `KeyResolver` reads that registry, not the broker directory.
  Command **authenticity** stays in tyoman's `cmdsign` (operator signature); it
  is applied **inside** the payload, so the layering is *sign-then-encrypt*: the
  agent's tyo-mq client opens the payload, then tyoman verifies the signature and
  executes. A compromised broker/server can neither read nor forge.
- **trymq chatroom / Secure DM:** the same primitive replaces the bespoke
  WebCrypto path — passphrase rooms use the group variant, DMs use 1:1 with
  fingerprint verification.

## Open decisions

1. Broadcast: fan-out vs group key first (recommend 1:1 first).
2. `KEY_PUBLISH` scope + lifetime (per-connection vs persisted in settings/store).
3. Whether the library also offers generic **signing** (integrity without
   confidentiality), or leaves that to apps (tyoman's cmdsign) — encryption is
   the more clearly generic primitive.
4. Key rotation / multiple `kid`s per identity (the format already carries `kid`;
   the resolver returns the current one, openers accept any known one).
