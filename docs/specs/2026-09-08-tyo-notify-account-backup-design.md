# TYO Notify — Account backup & restore (TYO ID)

**Status:** Design (approved for spec review) — 2026-09-08
**Spans:** `tyonotify` (Android app), `id.tyo.com.au` (backend), `tyo-mq` broker
(v2 only). This doc lives with the other tyo-notify design specs; implementation
is mostly in the app + id.tyo.

## 1. Problem & goal

Everything the TYO Notify app stores locally is destroyed on uninstall (and does
not move to a new phone):

- **Topics + server config + delivery modes** — plaintext `NotifyStore`
  (Gson over `PrefsPersistence`). Just data.
- **Publish tokens** — `store/SecretStore.java` (EncryptedSharedPreferences,
  keyed `"{serverId}/{topic}"`). 256-bit bearer secrets needed to *publish*.
- **The device key** — `core/DeviceKey.java`, one EC P-256 keypair in Android
  Keystore (alias `tyo-notify-device-key`), **non-exportable by construction**.
  Private-topic claims are pinned to this key; it is what proves ownership when
  the app registers for push or reads a claimed topic.

Because the device key can't leave the Keystore and dies on uninstall, a
reinstall (or new phone) can neither publish (lost tokens) nor receive on private
topics (lost claim key) — exactly the manual re-claim dance the owner hit on a
phone swap on 2026-09-08.

**Goal:** an optional "Sign in with TYO ID" that lets a user **back up their
topics + secrets** and **restore** them on reinstall / new device, so nothing is
lost. Loose integration — the **broker is unchanged in v1**.

### Decisions (owner, 2026-09-08)
1. **Architecture A now, spec B as v2.** A = client-side backup/restore. B =
   broker re-anchors claims to the TYO-ID subject (no secret leaves the device);
   spec'd here so it can layer on without rework (§9).
2. **Tiered storage:** non-sensitive → Google Drive appData; sensitive →
   id.tyo blob (and/or Drive). **Full tiered ships in v1** (both sinks).
3. **Encryption: passphrase optional** — default account-protected; optional
   zero-knowledge recovery passphrase.
4. **Device key exportable by default** — one software-key model for everyone;
   recovery is always possible (§4).

### Non-goals (v1)
- No broker changes (claims still authorized by device-key possession). The
  broker JWKS/identity re-anchor is v2 (§9).
- No automatic multi-device *live sync* — this is backup/restore, not real-time
  sync. Last-writer-wins on the vault is acceptable.
- iOS parity beyond the cross-platform id.tyo blob path (the iOS client can
  adopt the same Vault + id.tyo sink later; Drive appData is Android-only).

## 2. The Vault

A single versioned JSON document, split by sensitivity so the non-sensitive tier
can always be backed up while the sensitive tier is opt-in + warned.

```jsonc
{
  "vault_version": 1,
  "updated_at": 1788845858,        // client clock, for last-writer-wins
  "device_label": "Pixel / S25 Ultra",
  "public": {                       // NON-sensitive — always safe to store
    "servers": [ { "id": "freemq", "name": "freemq", "base_url": "https://freemq.tyo.com.au" } ],
    "topics":  [ {
      "name": "cron-cac31e", "server_id": "freemq",
      "delivery_mode": "FCM", "push_mode": "CONTENT", "min_priority": 1,
      "is_private": true, "muted": false, "color_seed": 12345
    } ]
  },
  "secret": {                       // SENSITIVE — opt-in, warned, maybe encrypted
    "device_key_pkcs8_b64": "…",    // the EXPORTABLE device private key (§4)
    "publish_tokens": { "freemq/cron-cac31e": "…", "freemq/tyostocks-signals": "…" }
  },
  "secret_enc": null                // when passphrase mode: {kdf, salt, nonce, ct} and `secret` omitted
}
```

- `public` is written by any sink with no warning.
- `secret` is present **only** when the user has opted into secret backup. In
  passphrase mode it is replaced by `secret_enc` (AES-256-GCM ciphertext; the
  plaintext `secret` never leaves the device).

## 3. Sign-in (tyoid-auth)

- Add the `tyoid-auth` library (`au.com.tyo.id`, `git@gitsrv:repos/tyoid-auth.git`)
  as a Gradle `includeBuild` + git submodule, the same way Hilia consumes it
  (`settings.gradle` substitution for `au.com.tyo:tyoid-auth`). Requires the
  loopback cleartext carve-out in `network_security_config.xml` (per the lib's
  README).
- New **Settings → Account** section: `TyoIdAuthClient(productName="tyo-notify").login(activity)`
  → `TyoIdResult(jwt, name, pictureUrl)`. Show name + avatar; "Sign out".
- Store the session JWT in **EncryptedSharedPreferences** (improve on Hilia,
  which used a plaintext `tyo_session` file). Refresh via id.tyo `auth/refresh`
  when needed.
- Sign-in is **optional** — the app works fully signed-out (status quo). It gates
  the id.tyo-blob sink and is the cross-platform account anchor.

**Important integration detail:** the TYO-ID JWT is a Strapi session token, **not**
a Google OAuth token with Drive scope. The Drive-appData sink therefore needs its
**own** Google Sign-In requesting `https://www.googleapis.com/auth/drive.appdata`
(`play-services-auth` + Drive REST v3). The two sign-ins are independent; a user
may use either, both, or neither. (Since TYO-ID's primary IdP is Google, the same
Google account is typically involved, but we must request the Drive scope
explicitly — it is not granted by the TYO-ID flow.)

## 4. Device key — exportable by default

Replace the non-extractable Keystore key with a **software-generated EC P-256
key** (SunEC/Conscrypt), stored PKCS8 in `SecretStore` (EncryptedSharedPreferences
at rest). Rationale: the publish tokens are already bearer secrets, so hardware
non-extractability of the signing key buys little for this app's threat model,
and exportability is what makes recovery possible. `DeviceKey`'s public API
(`ensureKeyPair`, `publicKeyBase64` (SPKI), `signBase64` (SHA256withECDSA/DER),
`exists`) is preserved so `NotifyAuth` and the broker's `importPubkey` are
unaffected; only key *generation/storage* changes, plus new `exportPkcs8Base64()`
/ `importPkcs8Base64()`.

**Migration (existing installs):** an existing user has a non-extractable Keystore
key with live claims (the owner: `cron-cac31e`, `contact-mail`,
`tyostocks-signals`, `tyostocks-alerts`). On first run of the new build:
1. Detect the legacy Keystore key.
2. Generate the new exportable software key.
3. **Re-home each private topic** from the legacy key to the new key — the same
   delete-claim-then-re-claim flow used manually on 2026-09-08 (broker
   `notify_claims` delete requires an admin/owner action; see Open Questions §11
   for the "self-service re-claim" gap). New publish tokens replace the old in
   `SecretStore`; any external publisher (bigdata cron, pymailer, tyostocks
   fleet) must get the rotated token.
4. Delete the legacy Keystore key.

Because the re-home rotates publish tokens and touches external publishers,
migration is **surfaced to the user and confirmed**, not silent. New installs
skip all of this (born exportable).

> This migration friction is precisely what architecture **B** (§9) removes — a
> reason to prioritise B once A is proven.

## 5. Backup sinks

A pluggable `BackupSink` interface: `push(Vault)` / `pull(): Vault?`. Two impls
in v1:

### 5a. DriveAppDataSink (Android)
- Google Sign-In (`drive.appdata` scope) → Drive REST v3.
- Stores the Vault as a single file `tyonotify-vault.json` in the
  **appDataFolder** (hidden, per-app, in the user's own Drive; survives
  uninstall; restored on Google re-sign-in).
- `public` tier auto-synced (no warning). `secret` tier included only when the
  user opts in (§6). Account-protected = it lives in *your* Drive.

### 5b. TyoIdBlobSink (cross-platform)
- New id.tyo endpoint (`§7`), Bearer TYO-ID session JWT.
- Stores the full Vault (public + secret) server-side. Account-protected =
  gated by your TYO account; operator could read `secret` unless passphrase mode.

**Which sink writes what (tiered default):**
- `public` → Drive appData (Android) automatically; also mirrored to the id.tyo
  blob when signed into TYO ID (so restore has a source on either).
- `secret` → written to the sink(s) the user opted into, with the warning.

Restore prefers whichever sink returns the newest `updated_at`.

## 6. Encryption & the warning

- **Default (account-protected):** no client encryption. `secret` sits in the
  user's Drive appData (Google-account-gated) and/or the id.tyo blob
  (TYO-account-gated, operator-readable). A **warning dialog** on enable states
  plainly: "Your publish tokens and this device's identity key will be copied to
  [Google Drive / your TYO account]. Anyone who can access that account — and, for
  TYO cloud backup, TYO — could read them. For end-to-end protection, set a
  recovery passphrase."
- **Optional recovery passphrase (zero-knowledge):** derive a 256-bit key with
  Argon2id (or PBKDF2-HMAC-SHA256 ≥ 200k iters if Argon2 unavailable) over the
  passphrase + random salt; AES-256-GCM encrypt the `secret` object →
  `secret_enc = {kdf, salt_b64, nonce_b64, ct_b64}`; omit plaintext `secret`.
  Neither sink (nor the operator/Google) can read it. **Forgotten passphrase =
  unrecoverable secret tier** (topics still restore) — stated in the UI.

## 7. id.tyo backend — vault endpoint

Mirror the existing `pages/api/mq-token.js` gate (`validateSession(Bearer jwt)` →
`uid`). Add:

- **Strapi content-type `notify-vault`**: `{ user (relation, unique), blob
  (JSON/longtext), vault_version (int), updated_at (int) }`, one row per user.
- **`pages/api/notify/vault.js`**:
  - `GET` (Bearer) → `{ blob }` or 404 if none.
  - `PUT` (Bearer, body `{ blob, updated_at }`) → upsert the caller's row;
    **reject if body.updated_at < stored.updated_at** (stale-write guard,
    last-writer-wins by client clock). Size cap (e.g. 256 KB).
  - `DELETE` (Bearer) → drop the row (user "forget my backup").
- The `blob` is opaque to id.tyo whenever passphrase mode is used; otherwise it
  is plaintext JSON on the server (the account-protected trade-off).

## 8. Restore flow (fresh install)

1. App has no local identity/topics → offer **"Restore from backup"**.
2. User signs in (TYO ID for the blob sink, and/or Google for Drive appData).
3. Pull the Vault from available sinks; pick newest `updated_at`.
4. If `secret_enc` present → prompt for the recovery passphrase; decrypt.
5. Restore `public` → `NotifyStore` (servers, topics); `secret.publish_tokens`
   → `SecretStore`; `secret.device_key_pkcs8_b64` → import into the software key
   store (`DeviceKey.importPkcs8Base64`).
6. **Re-register push** for each private topic — the restored device key signs
   the register proof, the broker matches it against the still-pinned claim, and
   delivery resumes. No re-claim.
7. Topics-only restore (no secret tier / no passphrase): topics reappear but
   private ones can't receive until re-claimed — the app marks them "needs
   re-claim" rather than silently failing.

## 9. v2 — TYO-ID re-anchor (spec only, not built)

The clean multi-device fix, reusing the machinery already proven for
`apps:hilia:*`:
- Add a notify `auth.external_validators[]` jwks entry (`realm_prefix` = the
  notify realm, `jwks_url` = id.tyo `/.well-known/jwks.json`, `aud` = `tyo-mq`),
  so the broker validates a TYO-ID RS256 JWT offline (`lib/jwks.js`) and binds
  `socket.tyoAuth.identity`/`sub`.
- Extend `notify_claims` with an optional `owner_sub`. A claim may be authorized
  by **either** the device-key proof (today) **or** a connection whose
  `tyoAuth.sub == owner_sub` (`lib/notify-auth.js` gains this alternative).
- Then a reinstall/new device just signs into TYO ID and re-registers — **no
  device key backup, no re-claim, no token rotation.** The Vault's `secret` tier
  becomes optional convenience rather than a necessity.

Designing v1's Vault + sink interfaces to already carry an (unused in v1)
`owner_sub`/account hint keeps this a pure addition.

## 10. Security considerations

- The account-protected default deliberately trades confidentiality for
  frictionless recovery; the warning + optional passphrase make the trade
  explicit and user-controlled.
- Making the device key exportable lowers its bar from "hardware, per-device" to
  "software secret alongside the tokens." Acceptable because (a) the tokens are
  already bearer secrets with the same exposure and (b) recovery is the whole
  point. Users who want hardware-bound non-recoverable identity simply never
  enable backup — but note "exportable by default" means the key *can* be
  exported even if never uploaded; if that's unacceptable we fall back to
  "exportable only when backup on" (the rejected option).
- The id.tyo vault endpoint is a new authenticated attack surface: enforce the
  Bearer-session gate exactly like `mq-token.js`, cap size, rate-limit, and never
  log the blob.
- Passphrase mode must use authenticated encryption (GCM) and a memory-hard KDF;
  never a bare hash.

## 11. Open questions / risks

1. **Self-service re-claim.** v1 migration (§4) and any topic re-home need the
   old `notify_claims` row deleted, which today is an admin/owner DB op (done
   manually on 2026-09-08). A proper flow needs a broker "release my claim"
   (device-key-signed) endpoint, or v2's `owner_sub` re-anchor. Decide whether
   v1 ships the migration via a broker self-service release endpoint or a
   guided/assisted one-time re-home.
2. **External publishers on rotation.** Re-homing rotates publish tokens; bigdata
   cron, pymailer, and the tyostocks fleet hold those tokens. v1 migration must
   enumerate + update them (tooling exists). v2 avoids this (no rotation).
3. **Drive scope UX.** Requesting `drive.appdata` is a separate Google consent;
   confirm the product is OK asking for it (it's the least-scary Drive scope —
   hidden app folder only).
4. **iOS.** The Vault + id.tyo blob sink are cross-platform; the iOS client adopts
   them later. Drive appData has no iOS equivalent (would use iCloud KVS/CloudKit).

## 12. Testing

- **Pure/unit (Android, `algo`-style standalone or JVM):** Vault (de)serialize
  round-trip; passphrase encrypt→decrypt round-trip + wrong-passphrase fails
  closed; device key export→import→sign verifies against the same pubkey;
  last-writer-wins merge picks newest.
- **id.tyo:** vault GET/PUT/DELETE auth gate (401 without Bearer), stale-write
  rejection, size cap.
- **On-device end-to-end:** enable backup → uninstall → reinstall → sign in →
  restore → a real push to a private topic arrives without any re-claim. Run on
  the daily phone via elitebook1 (the flow used throughout the notify work).
