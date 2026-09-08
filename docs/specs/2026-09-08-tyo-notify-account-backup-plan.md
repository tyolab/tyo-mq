# TYO Notify Account Backup & Restore — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Optional "Sign in with TYO ID" + tiered backup (Google Drive appData + id.tyo blob) of topics/tokens/device-key so uninstall/reinstall/new-phone restores everything without a manual re-claim.

**Architecture:** Client-side backup/restore (spec architecture A). Broker unchanged in v1. Device key becomes an exportable software EC P-256 key. Sensitive tier is opt-in + warned, with an optional zero-knowledge passphrase. Design: `docs/specs/2026-09-08-tyo-notify-account-backup-design.md`.

**Tech Stack:** Android (Java, tyodroid framework), Kotlin `tyoid-auth` (au.com.tyo.id) via Gradle includeBuild, Google Play Services Auth + Drive REST v3 (appDataFolder), Next.js + Strapi (id.tyo.com.au). Tests: standalone `assert` JVM scripts (`algo/test`-style is tyostocks; tyonotify uses JUnit under `app/src/test`).

**Repos:** `tyonotify` (app), `id.tyo.com.au` (backend). No `tyo-mq` code changes in v1.

**Discovery-dependent tasks** (Drive REST exact calls, Strapi content-type creation mechanics, Argon2 lib availability) are marked ⚙ — they specify the interface + tests + concrete approach; the implementer verifies exact API shapes against the live SDK/tool during the task rather than trusting fabricated calls (per the write-command-test skill's "run it first" discipline).

---

## Phase A — id.tyo `notify-vault` backend

Independent; ships an authenticated per-user vault store. All paths under `/data/tyolab/web/tyolab/id.tyo.com.au`.

### Task A1: Strapi `notify-vault` content-type ⚙

**Files:**
- Create: Strapi schema for content-type `notify-vault` (exact path depends on the Strapi version/layout — verify against the existing content-types, e.g. how `reach`/leaderboard types are defined; typically `src/api/notify-vault/content-types/notify-vault/schema.json` + controllers/routes/services, OR the admin content-type builder).

**Schema fields:**
- `user` — relation (oneToOne) to `plugin::users-permissions.user`, unique.
- `blob` — `text` (longtext; holds the Vault JSON or ciphertext envelope).
- `vault_version` — `integer`.
- `updated_at_client` — `biginteger` (client clock; distinct from Strapi's own `updatedAt`).

- [ ] **Step 1: Inspect how id.tyo/Strapi defines an existing per-user content-type**

Run: locate a precedent — `grep - rn "users-permissions.user" /data/tyolab/web/tyolab/id.tyo.com.au/../*strapi*/src 2>/dev/null` and read one existing `schema.json`. Confirm the Strapi project location (it may be a separate repo/dir from the Next.js app — the design notes `NEXT_PUBLIC_STRAPI_API_URL`). Expected: a `schema.json` shape to mirror.

- [ ] **Step 2: Create the content-type** mirroring that precedent with the fields above, `draftAndPublish: false`, and default (private) permissions — the Next.js API routes talk to Strapi with an admin/service token, not public REST.

- [ ] **Step 3: Verify** the collection exists: restart Strapi (or the dev instance) and confirm `notify-vault` appears and a row can be created for a user via the admin or an authenticated Strapi call. Expected: CRUD works for a single-user row.

- [ ] **Step 4: Commit** (in the Strapi repo): `feat(notify-vault): per-user backup vault content-type`.

### Task A2: `pages/api/notify/vault.js` route

**Files:**
- Create: `/data/tyolab/web/tyolab/id.tyo.com.au/pages/api/notify/vault.js`
- Reference: `pages/api/mq-token.js` (the `validateSession(Bearer)` → uid pattern to copy).

- [ ] **Step 1: Read `pages/api/mq-token.js`** end to end to copy its exact session-validation helper (`validateSession`/`fetchProfile`), Strapi base URL usage, and error shape.

- [ ] **Step 2: Implement the handler.** GET/PUT/DELETE, Bearer-gated, keyed by the resolved `uid` (never client-supplied), stale-write guard, 256 KB cap.

```js
// pages/api/notify/vault.js
import { validateSession } from '../../../lib/session'; // use the SAME helper mq-token.js uses; adjust import to match

const MAX_BLOB_BYTES = 256 * 1024;
const STRAPI = process.env.STRAPI_API_URL || process.env.NEXT_PUBLIC_STRAPI_API_URL;
const STRAPI_TOKEN = process.env.STRAPI_ADMIN_TOKEN; // service token used by mq-token.js et al.

async function strapiFindByUser(uid) {
  const r = await fetch(`${STRAPI}/api/notify-vaults?filters[user][id][$eq]=${uid}`, {
    headers: { Authorization: `Bearer ${STRAPI_TOKEN}` },
  });
  const j = await r.json();
  return (j.data && j.data[0]) || null; // {id, attributes:{blob,vault_version,updated_at_client}}
}

export default async function handler(req, res) {
  const auth = req.headers.authorization || '';
  const jwt = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!jwt) return res.status(401).json({ error: 'missing bearer' });

  let uid;
  try { uid = (await validateSession(jwt)).uid; }
  catch { return res.status(401).json({ error: 'invalid session' }); }
  if (!uid) return res.status(401).json({ error: 'no uid' });

  if (req.method === 'GET') {
    const row = await strapiFindByUser(uid);
    if (!row) return res.status(404).json({ error: 'no vault' });
    return res.status(200).json({
      blob: row.attributes.blob,
      vault_version: row.attributes.vault_version,
      updated_at: row.attributes.updated_at_client,
    });
  }

  if (req.method === 'PUT') {
    const { blob, updated_at, vault_version } = req.body || {};
    if (typeof blob !== 'string') return res.status(400).json({ error: 'blob required' });
    if (Buffer.byteLength(blob, 'utf8') > MAX_BLOB_BYTES) return res.status(413).json({ error: 'too large' });
    const incoming = Number(updated_at) || 0;
    const row = await strapiFindByUser(uid);
    if (row && Number(row.attributes.updated_at_client || 0) > incoming)
      return res.status(409).json({ error: 'stale write' }); // last-writer-wins by client clock
    const body = { data: { user: uid, blob, vault_version: Number(vault_version) || 1, updated_at_client: incoming } };
    const method = row ? 'PUT' : 'POST';
    const url = row ? `${STRAPI}/api/notify-vaults/${row.id}` : `${STRAPI}/api/notify-vaults`;
    const r = await fetch(url, { method, headers: { 'content-type': 'application/json', Authorization: `Bearer ${STRAPI_TOKEN}` }, body: JSON.stringify(body) });
    if (!r.ok) return res.status(502).json({ error: 'store failed' });
    return res.status(200).json({ ok: true });
  }

  if (req.method === 'DELETE') {
    const row = await strapiFindByUser(uid);
    if (row) await fetch(`${STRAPI}/api/notify-vaults/${row.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${STRAPI_TOKEN}` } });
    return res.status(200).json({ ok: true });
  }

  res.setHeader('Allow', 'GET, PUT, DELETE');
  return res.status(405).end();
}
```

> ⚙ Adjust `validateSession` import, the Strapi filter/field names (`updated_at_client`), and the env var names to whatever `mq-token.js` actually uses — confirm each against that file in Step 1, don't assume.

- [ ] **Step 3: Never log the blob.** Confirm no `console.log(blob)` anywhere.

- [ ] **Step 4: Commit:** `feat(notify): authenticated per-user backup vault endpoint`.

### Task A3: Vault endpoint tests ⚙

**Files:**
- Create: a test script matching id.tyo's existing test convention (inspect `pages/api/__tests__` or how mq-token is tested; if there is no harness, write a standalone node script that mocks `validateSession` + Strapi fetch).

- [ ] **Step 1:** Assert: no Bearer → 401; valid Bearer, no row → GET 404; PUT then GET round-trips the blob; PUT with `updated_at` older than stored → 409; blob > 256 KB → 413; DELETE removes it.
- [ ] **Step 2:** Run it, confirm green.
- [ ] **Step 3: Commit:** `test(notify): vault endpoint auth + stale-write + cap`.

---

## Phase B — App foundations (tyonotify, JVM-unit-testable)

All under `/data/tyolab/android/projects/tyonotify/app/src/main/java/au/com/tyo/notify/`. Tests under `app/src/test/java/au/com/tyo/notify/` (JUnit; confirm the app has a `test` sourceset — if only `androidTest` exists, add the `testImplementation junit` dep). Pure logic must NOT import Android classes so it runs on the JVM.

### Task B1: Vault model + (de)serialize

**Files:**
- Create: `core/backup/Vault.java` (POJOs: `Vault`, `VaultPublic`, `VaultSecret`, `ServerEntry`, `TopicEntry`), Gson-serializable, no Android imports.
- Create: `app/src/test/java/au/com/tyo/notify/backup/VaultTest.java`

- [ ] **Step 1: Write the failing test** — build a Vault with 1 server + 2 topics + secrets, `toJson()`/`fromJson()` round-trip, assert equality of every field; assert `secret` omitted when null serializes without `secret`.
- [ ] **Step 2: Run** `./gradlew :app:testDebugUnitTest --tests '*VaultTest'` → FAIL (class missing).
- [ ] **Step 3: Implement** the POJOs matching the design §2 schema (`vault_version`, `updated_at`, `device_label`, `public{servers,topics}`, `secret{device_key_pkcs8_b64,publish_tokens}`, `secret_enc`). Use Gson with `disableHtmlEscaping()`.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit:** `feat(backup): Vault model + json round-trip`.

### Task B2: Passphrase crypto ⚙

**Files:**
- Create: `core/backup/VaultCrypto.java` — `encryptSecret(secretJson, passphrase) -> SecretEnc{kdf,salt,nonce,ct}` and `decryptSecret(SecretEnc, passphrase) -> secretJson`. AES-256-GCM. KDF: Argon2id if a pure-JVM lib is available in the app's deps, else PBKDF2WithHmacSHA256 (≥200k iters) via `javax.crypto` (JVM-testable).
- Create: `backup/VaultCryptoTest.java`

- [ ] **Step 1: Decide the KDF** — check whether the app already pulls an Argon2 lib; if not, use PBKDF2 (javax.crypto, no new dep, JVM-testable). Record the choice in a class comment.
- [ ] **Step 2: Write the failing test** — encrypt a JSON string with passphrase "correct horse"; decrypt with the same passphrase returns the original; decrypt with a wrong passphrase THROWS (GCM tag failure), never returns garbage; salt+nonce are random per call (two encrypts differ).
- [ ] **Step 3: Run** → FAIL.
- [ ] **Step 4: Implement** using `SecretKeyFactory` PBKDF2 → 32-byte key, `Cipher AES/GCM/NoPadding` with a random 12-byte nonce and random 16-byte salt; serialize `{kdf:"pbkdf2-sha256", iters, salt_b64, nonce_b64, ct_b64}`.
- [ ] **Step 5: Run** → PASS. **Commit:** `feat(backup): passphrase AES-GCM vault encryption`.

### Task B3: Exportable DeviceKey + migration detection

**Files:**
- Modify: `core/DeviceKey.java` — replace the non-extractable Keystore keypair with a software EC P-256 key persisted (PKCS8) in `SecretStore`; keep `publicKeyBase64()` (SPKI DER b64), `signBase64()` (SHA256withECDSA/DER), `exists()`, `ensureKeyPair()` identical in behaviour. Add `exportPkcs8Base64()`, `importPkcs8Base64(String)`, and `legacyKeystoreKeyPresent()` (detects the old alias `tyo-notify-device-key`).
- Create: `backup/DeviceKeyPortableTest.java` (pure-JVM: exercise the key math directly with `java.security` — the export→import→sign→verify-against-same-pubkey round trip does not need Android, so factor the crypto into a JVM-testable helper `EcIdentity` that `DeviceKey` wraps with the Android storage).

- [ ] **Step 1: Factor** an Android-free `core/backup/EcIdentity.java`: `generate()`, `fromPkcs8(bytes)`, `pkcs8()`, `spkiPublic()`, `sign(bytes)`. `DeviceKey` becomes the Android storage wrapper around it.
- [ ] **Step 2: Write the failing test** (`EcIdentityTest`): `generate()` → `pkcs8()` → `fromPkcs8()` produces a key whose `spkiPublic()` equals the original and whose signature verifies with the original public key; a signature from the imported key verifies against the original SPKI.
- [ ] **Step 3: Run** → FAIL. **Step 4: Implement** `EcIdentity` (secp256r1, `KeyFactory`/`Signature "SHA256withECDSA"`, `PKCS8EncodedKeySpec`/`X509EncodedKeySpec`). Rewire `DeviceKey` to store `EcIdentity.pkcs8()` in `SecretStore` under a reserved key; `legacyKeystoreKeyPresent()` checks `KeyStore("AndroidKeyStore").containsAlias("tyo-notify-device-key")`.
- [ ] **Step 5: Run** → PASS. **Commit:** `feat(backup): exportable software device key + legacy detection`.

### Task B4: Vault assemble/apply

**Files:**
- Create: `core/backup/VaultManager.java` — `build(includeSecrets, passphraseOrNull): Vault` (reads `NotifyStore` topics/servers + `SecretStore` tokens + `DeviceKey.exportPkcs8Base64()`), and `apply(Vault, passphraseOrNull)` (writes them back: servers/topics → `NotifyStore`, tokens → `SecretStore`, key → `DeviceKey.importPkcs8Base64`). The pure merge/selection logic (what's public vs secret, newest-wins) lives in an Android-free helper for testing.
- Create: `backup/VaultManagerLogicTest.java` — for the pure parts: `build` with `includeSecrets=false` omits `secret`; with a passphrase produces `secret_enc` and no plaintext `secret`; `apply` of a passphrase vault with the wrong passphrase fails closed and changes nothing.

- [ ] **Step 1–4:** TDD the pure logic (build/apply selection + encryption wiring via B2), Android storage calls behind an interface stubbed in the test.
- [ ] **Step 5: Commit:** `feat(backup): assemble/apply Vault over stores`.

---

## Phase C — App integration + on-device e2e (tyonotify)

Integration-heavy; unit-test the pure bits, verify the rest on-device (the notify convention). Each task ends by building the APK on elitebook1 and, where noted, installing on the daily phone.

### Task C1: tyoid-auth sign-in ⚙

**Files:**
- Modify: `settings.gradle` (+ `build.gradle`) — add `tyoid-auth` as `includeBuild` / dependency substitution for `au.com.tyo:tyoid-auth`, mirroring Hilia's `settings.gradle`. Add the submodule at a repo path (git@gitsrv:repos/tyoid-auth.git).
- Modify: `app/src/main/res/xml/network_security_config.xml` — add the loopback cleartext carve-out (per tyoid-auth README).
- Create: `AccountActivity.java` (or a Settings section) driving `TyoIdAuthClient(productName="tyo-notify").login(activity)` → store `TyoIdResult.jwt` in a new `store/SessionStore.java` (EncryptedSharedPreferences). Show name/avatar + Sign out.

- [ ] **Step 1:** Read Hilia's `auth/TyoSignIn.kt` + `settings.gradle` substitution to copy the wiring exactly.
- [ ] **Step 2:** Wire the module + submodule; build `:app:assembleDebug` on elitebook1 → compiles.
- [ ] **Step 3:** Implement AccountActivity + SessionStore (encrypted, not Hilia's plaintext). Add a Settings entry point.
- [ ] **Step 4:** On-device: tap Sign in → complete the Custom Tab flow → name/avatar shown; kill+reopen → still signed in (JWT persisted). **Commit:** `feat(account): TYO ID sign-in + encrypted session`.

### Task C2: DriveAppDataSink ⚙

**Files:**
- Modify: `app/build.gradle` — add `play-services-auth` + Drive REST v3 (`google-api-services-drive` / `google-api-client-android`) deps.
- Create: `core/backup/BackupSink.java` (interface `push(Vault)`, `pull(): Vault?`, `name()`).
- Create: `store/DriveAppDataSink.java` — Google Sign-In requesting `DriveScopes.DRIVE_APPDATA`; read/write single file `tyonotify-vault.json` in `appDataFolder`.

- [ ] **Step 1: ⚙ Verify the Drive appData API** — the exact create-vs-update file call in `appDataFolder` (query `spaces=appDataFolder`, `files().create` with `setParents(["appDataFolder"])` vs `files().update`). Confirm against the Drive v3 Android quickstart before writing final code; write a tiny throwaway probe if unsure.
- [ ] **Step 2:** Implement the sink (find-or-create the file, upload the Vault JSON, download+parse on pull).
- [ ] **Step 3:** On-device: sign into Google (drive.appdata consent) → push a Vault → confirm the file exists (Drive API list) → pull returns the same Vault. **Commit:** `feat(backup): Google Drive appData sink`.

### Task C3: TyoIdBlobSink

**Files:**
- Create: `store/TyoIdBlobSink.java` — `PUT`/`GET https://id.tyo.com.au/api/notify/vault` with `Authorization: Bearer <session jwt>` (from SessionStore), body `{blob, updated_at, vault_version}`.

- [ ] **Step 1: Write** the sink against the A2 contract (reuse the app's existing `NotifyApi` HttpURLConnection style).
- [ ] **Step 2: Live test** against id.tyo (Phase A deployed to a dev/staging id.tyo, or prod if the endpoint is live): push→pull round-trip with a real session JWT. **Commit:** `feat(backup): id.tyo blob sink`.

### Task C4: BackupManager + UI (warning + passphrase + restore)

**Files:**
- Create: `core/backup/BackupManager.java` — orchestrates: public tier auto-sync to available sinks; secret tier only when `backupSecretsEnabled`; passphrase optional; newest-`updated_at` wins on restore.
- Create/modify: Settings UI — "Back up & restore" section: toggles (Drive / TYO cloud), "Back up my secrets (tokens + key)" with the **warning dialog** (design §6 wording), optional "Set recovery passphrase", "Restore now", "Delete cloud backup".
- Create: restore entry on a fresh install (dashboard empty-state → "Restore from backup").

- [ ] **Step 1:** Implement BackupManager (pure orchestration parts unit-tested: sink selection, newest-wins).
- [ ] **Step 2:** Build the Settings UI + warning dialog + passphrase prompt + restore screen.
- [ ] **Step 3:** On-device happy path: enable backup (accept warning) → push → uninstall → reinstall → Restore → topics + tokens reappear. **Commit:** `feat(backup): backup/restore UI + orchestration + warning`.

### Task C5: One-time legacy-key migration ⚙

**Files:**
- Create: `core/backup/KeyMigration.java` — on first run with `DeviceKey.legacyKeystoreKeyPresent()` true and any private topics: prompt the user; for each private topic, re-home to the new exportable key (release old claim + re-claim → new publish token into SecretStore), then delete the legacy alias.

- [ ] **Step 1: ⚙ Decide the release mechanism** (design §11 open Q): v1 = **assisted/owner-driven** re-home (the broker `notify_claims` delete is an admin op; for the OWNER this is driven manually as on 2026-09-08; for a general self-service flow, a broker "release my claim" endpoint is a follow-up — note explicitly, do not silently assume it exists).
- [ ] **Step 2:** Implement the app side of re-claim (it already has the claim flow); the broker-side release is external for v1.
- [ ] **Step 3:** Verify on the owner's device: migrate the 4 live private topics, rotate their tokens, update external publishers (bigdata cron, pymailer, tyostocks fleet) with the new tokens. **Commit:** `feat(backup): legacy key migration (assisted re-home)`.

### Task C6: On-device end-to-end

- [ ] **Step 1:** Fresh flow on the daily phone via elitebook1: enable backup + secrets (+ optional passphrase) → publish to a private topic (arrives) → **uninstall** → **reinstall** → sign in → Restore → **publish to the same private topic → it arrives with no re-claim**. This is the acceptance test for the whole feature.
- [ ] **Step 2:** Repeat with a passphrase-protected vault; wrong passphrase → topics-only restore, private topics marked "needs re-claim".
- [ ] **Step 3:** Bump app version, build signed AAB, sideload; update memory + wiki. **Commit:** `chore(release): account backup vX.Y.Z`.

---

## Self-review notes (spec coverage)

- Design §2 Vault → B1; §3 sign-in → C1; §4 exportable key + migration → B3, C5; §5 sinks → C2, C3; §6 crypto/warning → B2, C4; §7 id.tyo endpoint → A1–A3; §8 restore → C4, C6; §9 v2 → intentionally deferred (not in this plan); §10 security → enforced across A2 (never-log, cap), B2 (GCM), C4 (warning); §11 open questions → C5 Step 1 (release mechanism), C2/A1 (⚙ discovery), C3 (staging vs prod).
- Types are consistent (`Vault`/`VaultSecret`/`SecretEnc`, `EcIdentity`, `BackupSink`) across tasks.
- ⚙ tasks explicitly defer exact SDK/tool calls to implementation-time verification rather than fabricating them.
