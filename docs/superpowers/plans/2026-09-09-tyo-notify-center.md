# TYO Notify Center — Desktop tray client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Linux system-tray app that shows TYO Notify messages (incl. the owner's private topics) as native toasts + a recent-notifications menu, configured by signing in with TYO ID and pulling the account vault.

**Architecture:** Go single static binary. Pure, unit-tested units (`signer`, `signalfields`, `vault`, `store`, `subscriber`, `identity`) feed a thin `tray` UI. Delivery uses the broker's existing read contract — poll backfill (`/json?poll=1`) + SSE-ticket live stream (`/sse-ticket` → `/sse?ticket=`) — signed with the vault's exported device key. No new broker endpoints.

**Tech Stack:** Go 1.25, `github.com/getlantern/systray` v1.2.2 (tray, same as tyoman), `github.com/gen2brain/beeep` (libnotify toasts), `golang.org/x/crypto/pbkdf2` (passphrase vaults), stdlib `crypto/ecdsa`+`crypto/x509` (proof signing, DER), `net/http` (poll/SSE), `xdg-open` via `os/exec` (browser + URL open).

**Target repo:** new git repo at `/data/tyolab/go/tyo-notify-center`, module `github.com/tyolab/tyo-notify-center`.

**Reference:** broker contract in `tyo-mq/bin/notify-cli.js` + `tyo-mq/lib/notify-auth.js` + `tyo-mq/node_modules/tyo-mq-protocol/admin-signature.js`; blob shape in `tyonotify/app/src/main/java/au/com/tyo/notify/core/backup/Vault.java`. Design: `tyo-mq/docs/superpowers/specs/2026-09-09-tyo-notify-desktop-center-design.md`.

---

## File structure

```
tyo-notify-center/
  go.mod
  cmd/tyo-notify-center/main.go          # wiring + lifecycle (manual-verified)
  internal/signer/signer.go              # stableStringify, signatureBase, SignProof, LoadKey
  internal/signer/signer_test.go
  internal/signalfields/signalfields.go  # parse ntfy Tags CSV → Fields
  internal/signalfields/signalfields_test.go
  internal/notify/message.go             # NotifyMessage model + FromJSON
  internal/notify/message_test.go
  internal/vault/vault.go                # Vault struct, FromJSON, DecryptSecret
  internal/vault/vault_test.go
  internal/store/store.go                # config/state/key persistence (0600/0700)
  internal/store/store_test.go
  internal/subscriber/subscriber.go      # poll backfill + sse-ticket live loop + reconnect
  internal/subscriber/subscriber_test.go
  internal/identity/identity.go          # exchange + vault pull (http) + browser sign-in
  internal/identity/identity_test.go
  internal/tray/tray.go                  # systray UI + beeep toasts (manual-verified)
```

Each `internal/*` package has one responsibility and is testable without the tray. `tray` and `main` are the only pieces requiring a live desktop and are verified manually.

---

### Task 1: Project scaffold

**Files:**
- Create: `/data/tyolab/go/tyo-notify-center/go.mod`
- Create: `/data/tyolab/go/tyo-notify-center/cmd/tyo-notify-center/main.go`

- [ ] **Step 1: Create the repo + module**

```bash
mkdir -p /data/tyolab/go/tyo-notify-center/cmd/tyo-notify-center
cd /data/tyolab/go/tyo-notify-center
git init -q
go mod init github.com/tyolab/tyo-notify-center
go mod edit -go=1.25
```

- [ ] **Step 2: Minimal buildable main**

`cmd/tyo-notify-center/main.go`:
```go
// Command tyo-notify-center is a Linux system-tray client for TYO Notify.
package main

import "fmt"

func main() {
	fmt.Println("tyo-notify-center")
}
```

- [ ] **Step 3: Verify it builds**

Run: `cd /data/tyolab/go/tyo-notify-center && go build ./...`
Expected: exit 0, no output.

- [ ] **Step 4: Add .gitignore + commit**

```bash
printf 'tyo-notify-center\n/dist/\n*.log\n' > .gitignore
git add go.mod .gitignore cmd/tyo-notify-center/main.go
git commit -q -m "chore: scaffold tyo-notify-center Go module"
```

---

### Task 2: signer — byte-exact proof signing (the crux)

**Files:**
- Create: `internal/signer/signer.go`
- Test: `internal/signer/signer_test.go`

Mirrors `tyo-mq-protocol/admin-signature.js` `signatureBase`/`stableStringify` and `lib/notify-auth.js` signing. Bodies here are always flat `map[string]string` (claim: topic/pubkey/transport/token[/app_id/env]; reads: topic), so canonicalization is a sorted flat object — no recursion needed. **Critical:** JSON string encoding must NOT HTML-escape (`<>&`), matching JS `JSON.stringify`; use `SetEscapeHTML(false)`.

- [ ] **Step 1: Write the failing test (base string golden + self-verify)**

`internal/signer/signer_test.go`:
```go
package signer

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"testing"
)

func TestSignatureBaseGolden(t *testing.T) {
	body := map[string]string{
		"topic": "demo", "pubkey": "MFkwEwYH", "transport": "null", "token": "none",
	}
	got := SignatureBase("claim", body, 1788900000000, "a1b2c3d4e5f60718")
	want := "claim\n1788900000000\na1b2c3d4e5f60718\n" +
		`{"pubkey":"MFkwEwYH","token":"none","topic":"demo","transport":"null"}`
	if got != want {
		t.Fatalf("base mismatch:\n got=%q\nwant=%q", got, want)
	}
}

func TestCanonicalNoHTMLEscape(t *testing.T) {
	// JS JSON.stringify does not escape < > & ; ours must match.
	got := canonicalBody(map[string]string{"topic": "a<b>&c"})
	want := `{"topic":"a<b>&c"}`
	if got != want {
		t.Fatalf("html-escape leak: got=%q want=%q", got, want)
	}
}

func TestSignProofRoundTrip(t *testing.T) {
	priv, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	der, _ := x509.MarshalPKCS8PrivateKey(priv)
	s, err := LoadKey(base64.StdEncoding.EncodeToString(der))
	if err != nil {
		t.Fatal(err)
	}
	body := map[string]string{"topic": "demo"}
	p := s.SignProof("json", body)
	if p.Timestamp <= 0 || p.Nonce == "" || p.Signature == "" {
		t.Fatalf("empty proof: %+v", p)
	}
	// Verify with the matching public key exactly as the broker does (DER/ASN.1).
	base := SignatureBase("json", body, p.Timestamp, p.Nonce)
	sig, _ := base64.StdEncoding.DecodeString(p.Signature)
	sum := sha256Sum([]byte(base))
	if !ecdsa.VerifyASN1(&priv.PublicKey, sum, sig) {
		t.Fatal("signature did not verify (DER mismatch?)")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /data/tyolab/go/tyo-notify-center && go test ./internal/signer/`
Expected: FAIL — undefined `SignatureBase`, `canonicalBody`, `LoadKey`, `sha256Sum`.

- [ ] **Step 3: Implement signer.go**

`internal/signer/signer.go`:
```go
// Package signer builds and signs TYO Notify self-signed proofs, byte-identical
// to the broker's tyo-mq-protocol/admin-signature.js + lib/notify-auth.js.
package signer

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Proof is the {timestamp, nonce, signature} envelope carried in a claim/ticket
// body or in x-tyo-notify-* headers for reads.
type Proof struct {
	Timestamp int64  `json:"timestamp"`
	Nonce     string `json:"nonce"`
	Signature string `json:"signature"`
}

// Signer holds the EC P-256 device key (from the vault) used to sign proofs.
type Signer struct{ key *ecdsa.PrivateKey }

// LoadKey parses a base64 PKCS8 EC P-256 private key (vault device_key_pkcs8_b64).
func LoadKey(pkcs8B64 string) (*Signer, error) {
	der, err := base64.StdEncoding.DecodeString(pkcs8B64)
	if err != nil {
		return nil, err
	}
	k, err := x509.ParsePKCS8PrivateKey(der)
	if err != nil {
		return nil, err
	}
	ec, ok := k.(*ecdsa.PrivateKey)
	if !ok {
		return nil, errors.New("device key is not EC")
	}
	return &Signer{key: ec}, nil
}

func jsonString(s string) string {
	var b bytes.Buffer
	e := json.NewEncoder(&b)
	e.SetEscapeHTML(false) // match JS JSON.stringify (no <>& escaping)
	_ = e.Encode(s)
	return strings.TrimRight(b.String(), "\n")
}

// canonicalBody serializes a flat string map like admin-signature.js
// stableStringify: keys sorted, JSON string encoding, no HTML escaping.
func canonicalBody(body map[string]string) string {
	keys := make([]string, 0, len(body))
	for k := range body {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, k := range keys {
		parts = append(parts, jsonString(k)+":"+jsonString(body[k]))
	}
	return "{" + strings.Join(parts, ",") + "}"
}

// SignatureBase = [action, timestamp, nonce, canonicalBody(body)].join("\n").
func SignatureBase(action string, body map[string]string, ts int64, nonce string) string {
	return strings.Join([]string{
		action, strconv.FormatInt(ts, 10), nonce, canonicalBody(body),
	}, "\n")
}

func sha256Sum(b []byte) []byte { s := sha256.Sum256(b); return s[:] }

// SignProof produces a fresh proof for (action, body). Signature is base64 of
// the DER/ASN.1 ECDSA signature (matches Node crypto.sign default — NOT p1363).
func (s *Signer) SignProof(action string, body map[string]string) Proof {
	ts := time.Now().UnixMilli()
	nonce := newNonce()
	base := SignatureBase(action, body, ts, nonce)
	sig, _ := ecdsa.SignASN1(rand.Reader, s.key, sha256Sum([]byte(base)))
	return Proof{Timestamp: ts, Nonce: nonce, Signature: base64.StdEncoding.EncodeToString(sig)}
}

func newNonce() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	const hex = "0123456789abcdef"
	out := make([]byte, 32)
	for i, x := range b {
		out[i*2], out[i*2+1] = hex[x>>4], hex[x&0xf]
	}
	return string(out)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /data/tyolab/go/tyo-notify-center && go test ./internal/signer/ -v`
Expected: PASS (all three tests).

- [ ] **Step 5: Cross-verify against Node (belt-and-braces)**

Run:
```bash
cd /data/tyolab/go/tyo-notify-center
cat > /tmp/base.txt <<'EOF'
claim
1788900000000
a1b2c3d4e5f60718
{"pubkey":"MFkwEwYH","token":"none","topic":"demo","transport":"null"}
EOF
node -e 'const p=require("/data/tyolab/node/tyo-mq/node_modules/tyo-mq-protocol/admin-signature.js");
const b={topic:"demo",pubkey:"MFkwEwYH",transport:"null",token:"none"};
process.stdout.write(p.stableStringify?"" :"" );
const base=[ "claim","1788900000000","a1b2c3d4e5f60718", p.stableStringify(b)].join("\n");
console.log(base===require("fs").readFileSync("/tmp/base.txt","utf8").replace(/\n$/,"")?"MATCH":"MISMATCH");'
```
Expected: `MATCH`.

- [ ] **Step 6: Commit**

```bash
git add internal/signer/
git commit -q -m "feat(signer): byte-exact TYO Notify proof signing (DER, canonical body)"
```

---

### Task 3: signalfields — parse the structured Tags

**Files:**
- Create: `internal/signalfields/signalfields.go`
- Test: `internal/signalfields/signalfields_test.go`

Mirrors the Android `MessageFields` contract: ntfy `tags` is a CSV of `key=value` pairs; recognized keys `symbol,dir,level,strategy,market,price,sl,tp`. Never panics on malformed input.

- [ ] **Step 1: Write the failing test**

`internal/signalfields/signalfields_test.go`:
```go
package signalfields

import "testing"

func TestParse(t *testing.T) {
	f := Parse([]string{"symbol=ETHUSD", "dir=long", "level=h1", "price=2450", "junk", "=bad", "sl="})
	if f.Symbol != "ETHUSD" || f.Dir != "long" || f.Level != "h1" || f.Price != "2450" {
		t.Fatalf("bad parse: %+v", f)
	}
	if !f.HasFields() {
		t.Fatal("expected HasFields true")
	}
	if f.Get("nope") != "" {
		t.Fatal("unknown key should be empty")
	}
}

func TestParseEmpty(t *testing.T) {
	if Parse(nil).HasFields() {
		t.Fatal("nil tags → no fields")
	}
	if Parse([]string{"a", "b"}).HasFields() {
		t.Fatal("no key=value → no fields")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /data/tyolab/go/tyo-notify-center && go test ./internal/signalfields/`
Expected: FAIL — undefined `Parse`.

- [ ] **Step 3: Implement signalfields.go**

`internal/signalfields/signalfields.go`:
```go
// Package signalfields parses TYO Notify structured trading-signal fields out of
// the ntfy Tags CSV (key=value pairs), mirroring the Android MessageFields.
package signalfields

import "strings"

var known = map[string]bool{
	"symbol": true, "dir": true, "level": true, "strategy": true,
	"market": true, "price": true, "sl": true, "tp": true,
}

// Fields is the recognized subset; Raw keeps every parsed key=value.
type Fields struct {
	Symbol, Dir, Level, Strategy, Market, Price, SL, TP string
	Raw                                                 map[string]string
}

// Parse reads a slice of "key=value" tag tokens; unknown/malformed tokens are ignored.
func Parse(tags []string) Fields {
	f := Fields{Raw: map[string]string{}}
	for _, t := range tags {
		i := strings.IndexByte(t, '=')
		if i <= 0 {
			continue
		}
		k, v := strings.TrimSpace(t[:i]), strings.TrimSpace(t[i+1:])
		if k == "" || !known[k] {
			continue
		}
		f.Raw[k] = v
		switch k {
		case "symbol":
			f.Symbol = v
		case "dir":
			f.Dir = v
		case "level":
			f.Level = v
		case "strategy":
			f.Strategy = v
		case "market":
			f.Market = v
		case "price":
			f.Price = v
		case "sl":
			f.SL = v
		case "tp":
			f.TP = v
		}
	}
	return f
}

func (f Fields) HasFields() bool { return len(f.Raw) > 0 }
func (f Fields) Get(k string) string { return f.Raw[k] }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /data/tyolab/go/tyo-notify-center && go test ./internal/signalfields/ -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/signalfields/
git commit -q -m "feat(signalfields): parse structured trading-signal Tags"
```

---

### Task 4: notify message model

**Files:**
- Create: `internal/notify/message.go`
- Test: `internal/notify/message_test.go`

The broker's `/json` (ND-JSON) and `/sse` `data:` payloads are the ntfy-shaped message object (see `lib/notify.js` buildMessage): `{id,topic,time,event,message,title,priority,tags,click,content_type,actions}`.

- [ ] **Step 1: Write the failing test**

`internal/notify/message_test.go`:
```go
package notify

import "testing"

func TestFromJSON(t *testing.T) {
	m, err := FromJSON([]byte(`{"id":"n1","topic":"t","time":1788900000,"event":"message",
		"message":"hi","title":"T","priority":4,"tags":["symbol=ETHUSD","dir=long"],"click":"https://x"}`))
	if err != nil {
		t.Fatal(err)
	}
	if m.ID != "n1" || m.Title != "T" || m.Priority != 4 || len(m.Tags) != 2 || m.Click != "https://x" {
		t.Fatalf("bad: %+v", m)
	}
}

func TestFromJSONIgnoresNonMessageEvents(t *testing.T) {
	m, err := FromJSON([]byte(`{"event":"open","topic":"t"}`))
	if err != nil {
		t.Fatal(err)
	}
	if m.IsMessage() {
		t.Fatal("open event should not be a message")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /data/tyolab/go/tyo-notify-center && go test ./internal/notify/`
Expected: FAIL — undefined `FromJSON`.

- [ ] **Step 3: Implement message.go**

`internal/notify/message.go`:
```go
// Package notify models the ntfy-shaped message the broker streams over /json and /sse.
package notify

import "encoding/json"

type Message struct {
	ID          string   `json:"id"`
	Topic       string   `json:"topic"`
	Time        int64    `json:"time"`
	Event       string   `json:"event"`
	Message     string   `json:"message"`
	Title       string   `json:"title"`
	Priority    int      `json:"priority"`
	Tags        []string `json:"tags"`
	Click       string   `json:"click"`
	ContentType string   `json:"content_type"`
}

// FromJSON parses one ND-JSON / SSE data line into a Message.
func FromJSON(b []byte) (Message, error) {
	var m Message
	err := json.Unmarshal(b, &m)
	return m, err
}

// IsMessage reports whether this carries a user notification (vs open/keepalive).
func (m Message) IsMessage() bool { return m.Event == "" || m.Event == "message" }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /data/tyolab/go/tyo-notify-center && go test ./internal/notify/ -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/notify/
git commit -q -m "feat(notify): ntfy-shaped message model + FromJSON"
```

---

### Task 5: vault — parse the backup blob (plaintext secret)

**Files:**
- Create: `internal/vault/vault.go`
- Test: `internal/vault/vault_test.go`

Mirrors `Vault.java`. v1 supports the **plaintext `secret`** tier (owner's current backup). `secret_enc` (passphrase) parsing is present but decrypt is deferred to Task 9b with a real Android vector — `DecryptSecret` returns `ErrPassphraseUnsupported` until then, and the caller degrades to public-tier-only.

- [ ] **Step 1: Write the failing test**

`internal/vault/vault_test.go`:
```go
package vault

import "testing"

const plaintextBlob = `{"vault_version":1,"updated_at":1788845000,"device_label":"S25",
"public":{"servers":[{"id":"s1","name":"freemq","base_url":"https://freemq.tyo.com.au"}],
"topics":[{"name":"tyostocks-signals","server_id":"s1","is_private":true,"min_priority":1},
{"name":"hello","server_id":"s1","is_private":false}]},
"secret":{"device_key_pkcs8_b64":"AAA","device_key_spki_b64":"BBB",
"publish_tokens":{"tyostocks-signals":"deadbeef"}}}`

func TestFromJSON(t *testing.T) {
	v, err := FromJSON([]byte(plaintextBlob))
	if err != nil {
		t.Fatal(err)
	}
	if len(v.Public.Topics) != 2 || v.Public.Topics[0].Name != "tyostocks-signals" ||
		!v.Public.Topics[0].IsPrivate {
		t.Fatalf("topics: %+v", v.Public.Topics)
	}
	if v.Secret == nil || v.Secret.DeviceKeyPKCS8B64 != "AAA" {
		t.Fatalf("secret: %+v", v.Secret)
	}
	if v.BaseURLFor("s1") != "https://freemq.tyo.com.au" {
		t.Fatalf("baseurl: %q", v.BaseURLFor("s1"))
	}
}

func TestPassphraseUnsupported(t *testing.T) {
	v, _ := FromJSON([]byte(`{"secret_enc":{"kdf":"pbkdf2-sha256","iters":1,"salt_b64":"x","nonce_b64":"y","ct_b64":"z"}}`))
	if _, err := v.DecryptSecret("pw"); err != ErrPassphraseUnsupported {
		t.Fatalf("want ErrPassphraseUnsupported, got %v", err)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /data/tyolab/go/tyo-notify-center && go test ./internal/vault/`
Expected: FAIL — undefined `FromJSON`.

- [ ] **Step 3: Implement vault.go**

`internal/vault/vault.go`:
```go
// Package vault models the TYO Notify account-backup blob (see Vault.java).
package vault

import (
	"encoding/json"
	"errors"
)

var ErrPassphraseUnsupported = errors.New("passphrase-encrypted vaults are not supported on desktop yet")

type Vault struct {
	VaultVersion int         `json:"vault_version"`
	UpdatedAt    int64       `json:"updated_at"`
	DeviceLabel  string      `json:"device_label"`
	Public       Public      `json:"public"`
	Secret       *Secret     `json:"secret"`
	SecretEnc    *SecretEnc  `json:"secret_enc"`
}

type Public struct {
	Servers []Server `json:"servers"`
	Topics  []Topic  `json:"topics"`
}

type Server struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	BaseURL string `json:"base_url"`
}

type Topic struct {
	Name        string `json:"name"`
	ServerID    string `json:"server_id"`
	DeliveryMode string `json:"delivery_mode"`
	PushMode    string `json:"push_mode"`
	Muted       bool   `json:"muted"`
	MinPriority int    `json:"min_priority"`
	IsPrivate   bool   `json:"is_private"`
	LastSeenID  string `json:"last_seen_id"`
}

type Secret struct {
	DeviceKeyPKCS8B64 string            `json:"device_key_pkcs8_b64"`
	DeviceKeySPKIB64  string            `json:"device_key_spki_b64"`
	PublishTokens     map[string]string `json:"publish_tokens"`
}

type SecretEnc struct {
	KDF     string `json:"kdf"`
	Iters   int    `json:"iters"`
	SaltB64 string `json:"salt_b64"`
	NonceB64 string `json:"nonce_b64"`
	CtB64   string `json:"ct_b64"`
}

func FromJSON(b []byte) (Vault, error) {
	var v Vault
	err := json.Unmarshal(b, &v)
	return v, err
}

// BaseURLFor resolves a topic's server_id to its base URL, defaulting to freemq.
func (v Vault) BaseURLFor(serverID string) string {
	for _, s := range v.Public.Servers {
		if s.ID == serverID && s.BaseURL != "" {
			return s.BaseURL
		}
	}
	return "https://freemq.tyo.com.au"
}

// DecryptSecret returns the plaintext Secret. For passphrase vaults it returns
// ErrPassphraseUnsupported until Task 9b lands a verified decrypt.
func (v Vault) DecryptSecret(passphrase string) (*Secret, error) {
	if v.Secret != nil {
		return v.Secret, nil
	}
	if v.SecretEnc != nil {
		return nil, ErrPassphraseUnsupported
	}
	return nil, nil // public-tier-only backup
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /data/tyolab/go/tyo-notify-center && go test ./internal/vault/ -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/vault/
git commit -q -m "feat(vault): parse backup blob (plaintext secret; passphrase deferred)"
```

---

### Task 6: store — config/state/key persistence

**Files:**
- Create: `internal/store/store.go`
- Test: `internal/store/store_test.go`

Persists config (topics, per-topic mute/min_priority, jwt, base URLs, last_seen_id), the device key PKCS8, and the recent-notification ring, under a dir at `0700`, files at `0600`. Dir is injectable for tests.

- [ ] **Step 1: Write the failing test**

`internal/store/store_test.go`:
```go
package store

import (
	"os"
	"testing"
)

func TestRoundTripAndPerms(t *testing.T) {
	dir := t.TempDir()
	s := New(dir)
	c := Config{JWT: "j", DeviceKeyPKCS8B64: "k", Topics: []TopicPref{{Name: "a", Muted: true, MinPriority: 2}}}
	c.LastSeen = map[string]string{"a": "n5"}
	if err := s.SaveConfig(c); err != nil {
		t.Fatal(err)
	}
	got, err := s.LoadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if got.JWT != "j" || len(got.Topics) != 1 || !got.Topics[0].Muted || got.LastSeen["a"] != "n5" {
		t.Fatalf("roundtrip: %+v", got)
	}
	fi, _ := os.Stat(s.configPath())
	if fi.Mode().Perm() != 0o600 {
		t.Fatalf("config perms = %v, want 0600", fi.Mode().Perm())
	}
	di, _ := os.Stat(dir)
	if di.Mode().Perm() != 0o700 {
		t.Fatalf("dir perms = %v, want 0700", di.Mode().Perm())
	}
}

func TestLoadMissingIsEmpty(t *testing.T) {
	got, err := New(t.TempDir()).LoadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if got.JWT != "" || len(got.Topics) != 0 {
		t.Fatalf("missing config should be zero-value: %+v", got)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /data/tyolab/go/tyo-notify-center && go test ./internal/store/`
Expected: FAIL — undefined `New`.

- [ ] **Step 3: Implement store.go**

`internal/store/store.go`:
```go
// Package store persists desktop config, the device key, and the notification
// ring under ~/.config/tyo-notify-center (dir 0700, files 0600).
package store

import (
	"encoding/json"
	"os"
	"path/filepath"
)

type TopicPref struct {
	Name        string `json:"name"`
	IsPrivate   bool   `json:"is_private"`
	ServerID    string `json:"server_id"`
	Muted       bool   `json:"muted"`
	MinPriority int    `json:"min_priority"`
}

type Config struct {
	JWT               string            `json:"jwt"`
	JWTExp            int64             `json:"jwt_exp"`
	DeviceKeyPKCS8B64 string            `json:"device_key_pkcs8_b64"`
	DeviceKeySPKIB64  string            `json:"device_key_spki_b64"`
	Servers           map[string]string `json:"servers"` // server_id -> base_url
	Topics            []TopicPref       `json:"topics"`
	PublishTokens     map[string]string `json:"publish_tokens"`
	LastSeen          map[string]string `json:"last_seen"`
}

type Store struct{ dir string }

// New returns a Store rooted at dir. DefaultDir gives the real config path.
func New(dir string) *Store { return &Store{dir: dir} }

// DefaultDir is ~/.config/tyo-notify-center.
func DefaultDir() string {
	base, err := os.UserConfigDir()
	if err != nil {
		base = filepath.Join(os.Getenv("HOME"), ".config")
	}
	return filepath.Join(base, "tyo-notify-center")
}

func (s *Store) configPath() string { return filepath.Join(s.dir, "config.json") }

func (s *Store) ensureDir() error { return os.MkdirAll(s.dir, 0o700) }

func (s *Store) SaveConfig(c Config) error {
	if err := s.ensureDir(); err != nil {
		return err
	}
	b, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(s.configPath(), b, 0o600)
}

func (s *Store) LoadConfig() (Config, error) {
	var c Config
	b, err := os.ReadFile(s.configPath())
	if os.IsNotExist(err) {
		return c, nil
	}
	if err != nil {
		return c, err
	}
	err = json.Unmarshal(b, &c)
	return c, err
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /data/tyolab/go/tyo-notify-center && go test ./internal/store/ -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/store/
git commit -q -m "feat(store): config/key/ring persistence with 0700/0600 perms"
```

---

### Task 7: subscriber — poll backfill + SSE-ticket live loop

**Files:**
- Create: `internal/subscriber/subscriber.go`
- Test: `internal/subscriber/subscriber_test.go`

One `Subscriber` per topic. Backfill via `GET /notify/{topic}/json?poll=1&since=<since>` (signed headers for private), then live via `POST /notify/{topic}/sse-ticket` → `GET /notify/{topic}/sse?ticket=`. Public topics skip the proof. Reconnect with 1s→30s backoff. Uses an `httptest` server in tests. The `signer.Signer` is passed in (nil ⇒ public/bare).

- [ ] **Step 1: Write the failing test (poll backfill + ticketed SSE, private)**

`internal/subscriber/subscriber_test.go`:
```go
package subscriber

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/tyolab/tyo-notify-center/internal/notify"
	"github.com/tyolab/tyo-notify-center/internal/signer"
)

func testSigner(t *testing.T) *signer.Signer {
	priv, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	der, _ := x509.MarshalPKCS8PrivateKey(priv)
	s, err := signer.LoadKey(base64.StdEncoding.EncodeToString(der))
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func TestBackfillThenLive(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/notify/t/json", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("x-tyo-notify-signature") == "" {
			t.Error("expected signed poll for private topic")
		}
		fmt.Fprintln(w, `{"id":"h1","topic":"t","event":"message","message":"old"}`)
	})
	mux.HandleFunc("/notify/t/sse-ticket", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		fmt.Fprint(w, `{"ticket":"TICK"}`)
	})
	mux.HandleFunc("/notify/t/sse", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("ticket") != "TICK" {
			t.Errorf("missing ticket, got %q", r.URL.RawQuery)
		}
		fl, _ := w.(http.Flusher)
		fmt.Fprint(w, "event: message\ndata: {\"id\":\"n2\",\"topic\":\"t\",\"event\":\"message\",\"message\":\"live\"}\n\n")
		fl.Flush()
		<-r.Context().Done()
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	msgs := make(chan notify.Message, 8)
	sub := New(Options{
		BaseURL: srv.URL, Topic: "t", Private: true, Signer: testSigner(t),
		Client: srv.Client(), Since: "all", Out: msgs,
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go sub.Run(ctx)

	got := map[string]bool{}
	timeout := time.After(3 * time.Second)
	for len(got) < 2 {
		select {
		case m := <-msgs:
			got[m.ID] = true
		case <-timeout:
			t.Fatalf("only got %v", got)
		}
	}
	if !got["h1"] || !got["n2"] {
		t.Fatalf("missing backfill or live: %v", got)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /data/tyolab/go/tyo-notify-center && go test ./internal/subscriber/`
Expected: FAIL — undefined `New`/`Options`.

- [ ] **Step 3: Implement subscriber.go**

`internal/subscriber/subscriber.go`:
```go
// Package subscriber follows one TYO Notify topic: poll backfill then a
// ticketed SSE live stream, with reconnect/backoff. Mirrors bin/notify-cli.js.
package subscriber

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/tyolab/tyo-notify-center/internal/notify"
	"github.com/tyolab/tyo-notify-center/internal/signer"
)

type Options struct {
	BaseURL string
	Topic   string
	Private bool
	Signer  *signer.Signer // required when Private
	Client  *http.Client
	Since   string // "all" | last_seen_id | duration
	Out     chan<- notify.Message
	// OnSeen is called with each live message id so the caller can persist last_seen.
	OnSeen func(topic, id string)
}

type Subscriber struct{ o Options }

func New(o Options) *Subscriber {
	if o.Client == nil {
		o.Client = &http.Client{}
	}
	if o.Since == "" {
		o.Since = "all"
	}
	return &Subscriber{o: o}
}

func (s *Subscriber) signedGetHeaders(action string) http.Header {
	h := http.Header{}
	if s.o.Private && s.o.Signer != nil {
		p := s.o.Signer.SignProof(action, map[string]string{"topic": s.o.Topic})
		h.Set("x-tyo-notify-timestamp", itoa(p.Timestamp))
		h.Set("x-tyo-notify-nonce", p.Nonce)
		h.Set("x-tyo-notify-signature", p.Signature)
	}
	return h
}

func itoa(n int64) string { return strings.TrimSpace(string(appendInt(nil, n))) }
func appendInt(b []byte, n int64) []byte { return []byte(jsonNumber(n)) }
func jsonNumber(n int64) string { b, _ := json.Marshal(n); return string(b) }

// Run performs one backfill, then loops SSE with backoff until ctx is done.
func (s *Subscriber) Run(ctx context.Context) {
	s.backfill(ctx)
	backoff := time.Second
	for ctx.Err() == nil {
		opened := s.listenOnce(ctx)
		if opened {
			backoff = time.Second
		} else {
			backoff *= 2
			if backoff > 30*time.Second {
				backoff = 30 * time.Second
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
	}
}

func (s *Subscriber) backfill(ctx context.Context) {
	u := s.o.BaseURL + "/notify/" + url.PathEscape(s.o.Topic) + "/json?poll=1&since=" + url.QueryEscape(s.o.Since)
	req, _ := http.NewRequestWithContext(ctx, "GET", u, nil)
	req.Header = s.signedGetHeaders("json")
	resp, err := s.o.Client.Do(req)
	if err != nil {
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return
	}
	sc := bufio.NewScanner(resp.Body)
	sc.Buffer(make([]byte, 0, 64*1024), 1<<20)
	for sc.Scan() {
		line := bytes.TrimSpace(sc.Bytes())
		if len(line) == 0 {
			continue
		}
		if m, err := notify.FromJSON(line); err == nil && m.IsMessage() {
			s.emit(m, false)
		}
	}
}

// ticket fetches a single-use SSE ticket; returns "" for public topics or on error.
func (s *Subscriber) ticket(ctx context.Context) (string, error) {
	if !s.o.Private || s.o.Signer == nil {
		return "", nil
	}
	p := s.o.Signer.SignProof("sse-ticket", map[string]string{"topic": s.o.Topic})
	body, _ := json.Marshal(p)
	u := s.o.BaseURL + "/notify/" + url.PathEscape(s.o.Topic) + "/sse-ticket"
	req, _ := http.NewRequestWithContext(ctx, "POST", u, bytes.NewReader(body))
	req.Header.Set("content-type", "application/json")
	resp, err := s.o.Client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return "", errors.New("sse-ticket status " + resp.Status)
	}
	var out struct {
		Ticket string `json:"ticket"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return "", err
	}
	return out.Ticket, nil
}

// listenOnce opens the SSE stream and dispatches until it closes. Returns true
// if the stream opened (200), so the caller can reset backoff.
func (s *Subscriber) listenOnce(ctx context.Context) bool {
	tk, _ := s.ticket(ctx) // "" → bare connect (public or unclaimed fallback)
	u := s.o.BaseURL + "/notify/" + url.PathEscape(s.o.Topic) + "/sse"
	if tk != "" {
		u += "?ticket=" + url.QueryEscape(tk)
	}
	req, _ := http.NewRequestWithContext(ctx, "GET", u, nil)
	req.Header.Set("accept", "text/event-stream")
	resp, err := s.o.Client.Do(req)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return false
	}
	sc := bufio.NewScanner(resp.Body)
	sc.Buffer(make([]byte, 0, 64*1024), 1<<20)
	var data []string
	event := "message"
	for sc.Scan() {
		line := strings.TrimRight(sc.Text(), "\r")
		switch {
		case line == "":
			if len(data) > 0 && event == "message" {
				if m, err := notify.FromJSON([]byte(strings.Join(data, "\n"))); err == nil && m.IsMessage() {
					s.emit(m, true)
				}
			}
			data, event = nil, "message"
		case strings.HasPrefix(line, "event:"):
			event = strings.TrimSpace(line[6:])
		case strings.HasPrefix(line, "data:"):
			data = append(data, strings.TrimPrefix(strings.TrimPrefix(line[5:], " "), " "))
		}
	}
	return true
}

func (s *Subscriber) emit(m notify.Message, live bool) {
	if live && s.o.OnSeen != nil && m.ID != "" {
		s.o.OnSeen(s.o.Topic, m.ID)
	}
	select {
	case s.o.Out <- m:
	default: // never block the network loop on a full UI channel
	}
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /data/tyolab/go/tyo-notify-center && go test ./internal/subscriber/ -v`
Expected: PASS.

- [ ] **Step 5: Add a reconnect test**

Append to `internal/subscriber/subscriber_test.go`:
```go
func TestBareFallbackWhenTicket404(t *testing.T) {
	var bareHit bool
	mux := http.NewServeMux()
	mux.HandleFunc("/notify/pub/json", func(w http.ResponseWriter, r *http.Request) {})
	mux.HandleFunc("/notify/pub/sse-ticket", func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "not claimed", 404)
	})
	mux.HandleFunc("/notify/pub/sse", func(w http.ResponseWriter, r *http.Request) {
		bareHit = r.URL.RawQuery == ""
		fl, _ := w.(http.Flusher)
		fmt.Fprint(w, "data: {\"id\":\"n9\",\"event\":\"message\"}\n\n")
		fl.Flush()
		<-r.Context().Done()
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	msgs := make(chan notify.Message, 4)
	sub := New(Options{BaseURL: srv.URL, Topic: "pub", Private: true, Signer: testSigner(t), Client: srv.Client(), Out: msgs})
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	go sub.Run(ctx)
	select {
	case <-msgs:
		if !bareHit {
			t.Fatal("expected bare SSE fallback after ticket 404")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("no message via bare fallback")
	}
}
```
Run: `cd /data/tyolab/go/tyo-notify-center && go test ./internal/subscriber/ -run TestBareFallback -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add internal/subscriber/
git commit -q -m "feat(subscriber): poll backfill + ticketed SSE live loop w/ reconnect"
```

---

### Task 8: identity — token exchange + vault pull (HTTP)

**Files:**
- Create: `internal/identity/identity.go`
- Test: `internal/identity/identity_test.go`

The testable HTTP half: `ExchangeCode(idBase, code)` → JWT (POST `/api/auth/exchange`), and `PullVault(idBase, jwt)` → `vault.Vault` (GET `/api/notify/vault`, Bearer, blob is a JSON *string* inside `{blob,...}`). The browser+localhost-callback sign-in is a thin wrapper verified manually in Task 10.

- [ ] **Step 1: Write the failing test**

`internal/identity/identity_test.go`:
```go
package identity

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestExchangeAndPull(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/auth/exchange", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		w.Write([]byte(`{"jwt":"JWT123"}`))
	})
	mux.HandleFunc("/api/notify/vault", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer JWT123" {
			t.Errorf("bad auth: %q", r.Header.Get("Authorization"))
		}
		w.Header().Set("content-type", "application/json")
		// blob is a STRING containing the vault JSON.
		w.Write([]byte(`{"vault_version":1,"updated_at":1,"blob":"{\"public\":{\"topics\":[{\"name\":\"t\",\"is_private\":true}]}}"}`))
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	c := &Client{IDBase: srv.URL, HTTP: srv.Client()}
	jwt, err := c.ExchangeCode("code-abc")
	if err != nil || jwt != "JWT123" {
		t.Fatalf("exchange: %q %v", jwt, err)
	}
	v, err := c.PullVault(jwt)
	if err != nil {
		t.Fatal(err)
	}
	if len(v.Public.Topics) != 1 || v.Public.Topics[0].Name != "t" {
		t.Fatalf("vault: %+v", v.Public.Topics)
	}
}

func TestPullVault404IsNil(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "no vault", 404)
	}))
	defer srv.Close()
	c := &Client{IDBase: srv.URL, HTTP: srv.Client()}
	if _, err := c.PullVault("j"); err != ErrNoVault {
		t.Fatalf("want ErrNoVault, got %v", err)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /data/tyolab/go/tyo-notify-center && go test ./internal/identity/`
Expected: FAIL — undefined `Client`.

- [ ] **Step 3: Implement identity.go**

`internal/identity/identity.go`:
```go
// Package identity handles TYO ID sign-in (browser + localhost callback) and
// pulling the account's Notify vault. IDBase defaults to https://id.tyo.com.au.
package identity

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/tyolab/tyo-notify-center/internal/vault"
)

const DefaultIDBase = "https://id.tyo.com.au"

var ErrNoVault = errors.New("no vault for this account")

type Client struct {
	IDBase string
	HTTP   *http.Client
}

func (c *Client) base() string {
	if c.IDBase == "" {
		return DefaultIDBase
	}
	return c.IDBase
}
func (c *Client) http() *http.Client {
	if c.HTTP == nil {
		return http.DefaultClient
	}
	return c.HTTP
}

// ExchangeCode swaps a one-time auth code for a Strapi session JWT.
func (c *Client) ExchangeCode(code string) (string, error) {
	body, _ := json.Marshal(map[string]string{"code": code})
	req, _ := http.NewRequest("POST", c.base()+"/api/auth/exchange", bytes.NewReader(body))
	req.Header.Set("content-type", "application/json")
	resp, err := c.http().Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return "", errors.New("exchange failed: " + resp.Status)
	}
	var out struct {
		JWT   string `json:"jwt"`
		Error string `json:"error"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return "", err
	}
	if out.JWT == "" {
		return "", errors.New("exchange returned no jwt")
	}
	return out.JWT, nil
}

// PullVault GETs the account vault; the response `blob` is a JSON string.
func (c *Client) PullVault(jwt string) (vault.Vault, error) {
	var v vault.Vault
	req, _ := http.NewRequest("GET", c.base()+"/api/notify/vault", nil)
	req.Header.Set("Authorization", "Bearer "+jwt)
	req.Header.Set("Accept", "application/json")
	resp, err := c.http().Do(req)
	if err != nil {
		return v, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == 404 {
		return v, ErrNoVault
	}
	if resp.StatusCode != 200 {
		return v, errors.New("vault pull failed: " + resp.Status)
	}
	raw, _ := io.ReadAll(resp.Body)
	var wrap struct {
		Blob string `json:"blob"`
	}
	if err := json.Unmarshal(raw, &wrap); err != nil {
		return v, err
	}
	if wrap.Blob == "" {
		return v, ErrNoVault
	}
	return vault.FromJSON([]byte(wrap.Blob))
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /data/tyolab/go/tyo-notify-center && go test ./internal/identity/ -v`
Expected: PASS.

- [ ] **Step 5: Add the browser sign-in wrapper (manual-verified)**

Append to `internal/identity/identity.go`:
```go
import_stub_removed // (no-op marker; real imports below are added to the block above)

// SignIn opens the browser to id.tyo, runs a localhost callback to capture the
// auth code, then exchanges it. Blocks until the code arrives or ctx is done.
// (Verified manually in Task 10 — no unit test drives a real browser.)
```
Then add, in a new file `internal/identity/signin.go`:
```go
package identity

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/url"
	"os/exec"
)

// SignIn performs the interactive OAuth-code flow and returns a JWT.
func (c *Client) SignIn(ctx context.Context) (string, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return "", err
	}
	defer ln.Close()
	redirect := "http://" + ln.Addr().String() + "/callback"

	codeCh := make(chan string, 1)
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		code := r.URL.Query().Get("code")
		w.Header().Set("content-type", "text/html")
		w.Write([]byte("<h3>TYO Notify Center: signed in. You can close this tab.</h3>"))
		select {
		case codeCh <- code:
		default:
		}
	})}
	go srv.Serve(ln)
	defer srv.Close()

	login := c.base() + "/login?" + url.Values{
		"state":        {"tyo-notify-center"},
		"product":      {"TYO Notify Center"},
		"redirect_uri": {redirect},
	}.Encode()
	_ = exec.Command("xdg-open", login).Start()

	select {
	case <-ctx.Done():
		return "", ctx.Err()
	case code := <-codeCh:
		if code == "" {
			return "", errors.New("no code in callback")
		}
		return c.ExchangeCode(code)
	}
}
```
Remove the `import_stub_removed` marker line you added to identity.go.

- [ ] **Step 6: Verify build**

Run: `cd /data/tyolab/go/tyo-notify-center && go build ./... && go test ./internal/identity/ -v`
Expected: build OK, tests PASS.

- [ ] **Step 7: Commit**

```bash
git add internal/identity/
git commit -q -m "feat(identity): code exchange + vault pull + browser sign-in"
```

---

### Task 9: tray + toasts + app wiring (manual-verified)

**Files:**
- Create: `internal/tray/tray.go`
- Modify: `cmd/tyo-notify-center/main.go`
- Modify: `go.mod` (add systray + beeep)

Thin UI over the tested units. `getlantern/systray` runs the event loop; `beeep` fires toasts. No unit tests (needs a live tray); verified by running.

- [ ] **Step 1: Add deps**

```bash
cd /data/tyolab/go/tyo-notify-center
go get github.com/getlantern/systray@v1.2.2
go get github.com/gen2brain/beeep@latest
```

- [ ] **Step 2: Implement tray.go**

`internal/tray/tray.go`:
```go
// Package tray renders the system-tray UI and fires native toasts.
package tray

import (
	"fmt"

	"github.com/gen2brain/beeep"
	"github.com/getlantern/systray"
	"github.com/tyolab/tyo-notify-center/internal/notify"
	"github.com/tyolab/tyo-notify-center/internal/signalfields"
)

// Item is one line in the recent-notifications menu.
type Item struct {
	title string
	url   string
	mi    *systray.MenuItem
}

// UI holds the menu state; App feeds it via Add.
type UI struct {
	recent []*Item
	quit   chan struct{}
}

func New() *UI { return &UI{quit: make(chan struct{})} }
func (u *UI) Quit() <-chan struct{} { return u.quit }

// Title/body rendering shared by toast + menu.
func Render(m notify.Message) (title, body string) {
	f := signalfields.Parse(m.Tags)
	if f.HasFields() {
		title = f.Symbol
		if f.Dir != "" {
			title += " " + f.Dir
		}
		if f.Level != "" {
			title += " " + f.Level
		}
		body = m.Message
		if f.Price != "" {
			body = "@" + f.Price + "  " + body
		}
		return title, body
	}
	title = m.Title
	if title == "" {
		title = m.Topic
	}
	return title, m.Message
}

// OnReady returns the systray onReady callback that builds the static menu.
func (u *UI) OnReady(onSignIn func()) func() {
	return func() {
		systray.SetTitle("TYO Notify")
		systray.SetTooltip("TYO Notify Center")
		mSignIn := systray.AddMenuItem("Sign in with TYO ID", "")
		systray.AddSeparator()
		mQuit := systray.AddMenuItem("Quit", "")
		go func() {
			for {
				select {
				case <-mSignIn.ClickedCh:
					onSignIn()
				case <-mQuit.ClickedCh:
					close(u.quit)
					systray.Quit()
					return
				}
			}
		}()
	}
}

// Notify fires a toast and prepends a menu item (called from the app loop).
func (u *UI) Notify(m notify.Message) {
	title, body := Render(m)
	_ = beeep.Notify(title, body, "")
	mi := systray.AddMenuItem(fmt.Sprintf("%s — %s", title, body), m.Click)
	it := &Item{title: title, url: m.Click, mi: mi}
	u.recent = append([]*Item{it}, u.recent...)
	go func() {
		for range mi.ClickedCh {
			openURL(it.url)
		}
	}()
}
```

Add `internal/tray/open.go`:
```go
package tray

import "os/exec"

func openURL(u string) {
	if u == "" {
		return
	}
	_ = exec.Command("xdg-open", u).Start()
}
```

- [ ] **Step 3: Wire main.go**

`cmd/tyo-notify-center/main.go`:
```go
// Command tyo-notify-center is a Linux system-tray client for TYO Notify.
package main

import (
	"context"
	"log"

	"github.com/getlantern/systray"
	"github.com/tyolab/tyo-notify-center/internal/identity"
	"github.com/tyolab/tyo-notify-center/internal/notify"
	"github.com/tyolab/tyo-notify-center/internal/signer"
	"github.com/tyolab/tyo-notify-center/internal/store"
	"github.com/tyolab/tyo-notify-center/internal/subscriber"
	"github.com/tyolab/tyo-notify-center/internal/tray"
)

func main() {
	st := store.New(store.DefaultDir())
	ui := tray.New()
	msgs := make(chan notify.Message, 64)
	ctx, cancel := context.WithCancel(context.Background())

	app := &app{st: st, ui: ui, msgs: msgs, ctx: ctx}
	go app.pump()
	go func() { <-ui.Quit(); cancel() }()

	systray.Run(ui.OnReady(app.signIn), func() {})
	_ = cancel
}

type app struct {
	st   *store.Store
	ui   *tray.UI
	msgs chan notify.Message
	ctx  context.Context
}

// pump starts subscribers from cached config, then relays messages to the tray.
func (a *app) pump() {
	cfg, _ := a.st.LoadConfig()
	a.startSubscribers(cfg)
	for m := range a.msgs {
		a.ui.Notify(m)
	}
}

func (a *app) startSubscribers(cfg store.Config) {
	var sg *signer.Signer
	if cfg.DeviceKeyPKCS8B64 != "" {
		if s, err := signer.LoadKey(cfg.DeviceKeyPKCS8B64); err == nil {
			sg = s
		}
	}
	for _, tp := range cfg.Topics {
		base := cfg.Servers[tp.ServerID]
		if base == "" {
			base = "https://freemq.tyo.com.au"
		}
		since := cfg.LastSeen[tp.Name]
		if since == "" {
			since = "all"
		}
		sub := subscriber.New(subscriber.Options{
			BaseURL: base, Topic: tp.Name, Private: tp.IsPrivate, Signer: sg,
			Since: since, Out: a.msgs,
			OnSeen: func(topic, id string) { a.persistSeen(topic, id) },
		})
		go sub.Run(a.ctx)
	}
}

func (a *app) persistSeen(topic, id string) {
	cfg, _ := a.st.LoadConfig()
	if cfg.LastSeen == nil {
		cfg.LastSeen = map[string]string{}
	}
	cfg.LastSeen[topic] = id
	_ = a.st.SaveConfig(cfg)
}

// signIn runs the interactive flow, pulls the vault, persists config, restarts.
func (a *app) signIn() {
	c := &identity.Client{}
	jwt, err := c.SignIn(a.ctx)
	if err != nil {
		log.Println("sign-in:", err)
		return
	}
	v, err := c.PullVault(jwt)
	if err != nil {
		log.Println("vault:", err)
		return
	}
	sec, _ := v.DecryptSecret("")
	cfg, _ := a.st.LoadConfig()
	cfg.JWT = jwt
	cfg.Servers = map[string]string{}
	for _, s := range v.Public.Servers {
		cfg.Servers[s.ID] = s.BaseURL
	}
	cfg.Topics = cfg.Topics[:0]
	for _, tp := range v.Public.Topics {
		cfg.Topics = append(cfg.Topics, store.TopicPref{
			Name: tp.Name, IsPrivate: tp.IsPrivate, ServerID: tp.ServerID, MinPriority: tp.MinPriority,
		})
	}
	if sec != nil {
		cfg.DeviceKeyPKCS8B64 = sec.DeviceKeyPKCS8B64
		cfg.DeviceKeySPKIB64 = sec.DeviceKeySPKIB64
		cfg.PublishTokens = sec.PublishTokens
	}
	_ = a.st.SaveConfig(cfg)
	a.startSubscribers(cfg)
}
```

- [ ] **Step 4: Build**

Run: `cd /data/tyolab/go/tyo-notify-center && go build ./... && go vet ./...`
Expected: build OK, vet clean. (Fix any compile errors before proceeding.)

- [ ] **Step 5: Commit**

```bash
git add go.mod go.sum internal/tray/ cmd/
git commit -q -m "feat(tray): systray UI + toasts + app wiring (sign-in, subscribers)"
```

---

### Task 10: End-to-end live verification (manual)

**Files:** none (verification only).

- [ ] **Step 1: Full test suite green**

Run: `cd /data/tyolab/go/tyo-notify-center && go test ./... -count=1`
Expected: ok for signer, signalfields, notify, vault, store, subscriber, identity.

- [ ] **Step 2: Run the app, sign in**

Run: `cd /data/tyolab/go/tyo-notify-center && go run ./cmd/tyo-notify-center`
Expected: tray icon appears; "Sign in with TYO ID" opens the browser; after signing in as the owner (Eric Tang), the callback tab says signed in; `~/.config/tyo-notify-center/config.json` now lists the vault topics and the device key is populated.

- [ ] **Step 3: Live signal → toast**

Publish a test signal to a private topic using the existing cron token (from `bigdata:~/cronmon/publish.token`) or `bin/notify-cli.js`:
```bash
curl -H "Authorization: Bearer <publish-token>" \
     -H "Tags: symbol=ETHUSD,dir=long,level=h1,price=2450,strategy=trend" \
     -d "ETHUSD long h1 @2450" https://freemq.tyo.com.au/notify/tyostocks-signals
```
Expected: a native desktop toast titled `ETHUSD long h1` with body `@2450 …`; a new item appears in the tray menu; clicking it (if a click URL is set) opens the browser. `config.json` `last_seen` updates for the topic.

- [ ] **Step 4: Reconnect sanity**

Temporarily drop network / block freemq, confirm the app keeps running and resumes delivery (backfill via `since=<last_seen>`) when restored. No crash.

- [ ] **Step 5: Tag the working v0.1.0**

```bash
cd /data/tyolab/go/tyo-notify-center
git tag -a v0.1.0 -m "TYO Notify Center v0.1.0 — Linux tray client, TYO ID + private topics"
```

---

### Task 9b (optional, deferred): passphrase-encrypted vault decrypt

Only if the owner ever sets a backup passphrase. Requires a REAL Android-produced `secret_enc` vector (capture one from the phone) to write a decrypt test against — do not ship unverified crypto. Implement `DecryptSecret` with `golang.org/x/crypto/pbkdf2` (SHA-256, `iters`, `salt_b64` → 32-byte key) + AES-256-GCM (`nonce_b64` = 12-byte IV, `ct_b64` = ciphertext‖tag) and a table test using the captured vector. Until then, `ErrPassphraseUnsupported` (Task 5) is the correct behaviour.

---

## Self-review notes

- **Spec coverage:** tray/toasts (T9), TYO ID sign-in + vault pull (T8), device-key signing (T2), poll+SSE-ticket delivery (T7), structured rendering (T3), storage 0600/0700 (T6), reconnect/backoff (T7), JWT-expiry resilience (subscribers run on cached key — T9 `pump` starts from cached config before any sign-in), passphrase constraint (T5 + deferred T9b). All present.
- **Type consistency:** `signer.Signer`/`Proof`, `notify.Message`, `vault.Vault/Secret/Topic`, `store.Config/TopicPref`, `subscriber.Options` names are used identically across tasks.
- **No new broker endpoints** — every call (`/json?poll=1`, `/sse-ticket`, `/sse`) exists today (verified in the running broker + `bin/notify-cli.js`).
- **Deferred with cause:** passphrase decrypt (needs a real vector); per-topic mute/min-priority *enforcement* in the toast filter is a small follow-up (prefs are persisted in T6; wire the filter into `app.pump` when desired).
