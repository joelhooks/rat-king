// Independent, test-only envelope implementation. No rat-king code is imported.
package main

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"os"
	"reflect"
	"regexp"
	"strings"
	"time"

	"github.com/cloudflare/circl/hpke"
	"github.com/fxamacker/cbor/v2"
)

type node = map[string]any

var codec cbor.EncMode
var decoder cbor.DecMode
var suite = hpke.NewSuite(hpke.KEM_P256_HKDF_SHA256, hpke.KDF_HKDF_SHA256, hpke.AEAD_AES128GCM)
var suiteNode = node{"kemId": int64(16), "kdfId": int64(1), "aeadId": int64(1)}
var info = []byte("sh.mschf.ratking.hpke.v1")
var domain = []byte("sh.mschf.ratking.signature.v1\x00")
var aadDomain = []byte("sh.mschf.ratking.aad.v1\x00")
var failure = errors.New("invalid envelope")
var tid = regexp.MustCompile(`^[234567abcdefghijklmnopqrstuvwxyz]{13}$`)
var did = regexp.MustCompile(`^did:[a-z]+:[A-Za-z0-9._:%-]+$`)

func must[T any](value T, err error) T {
	if err != nil {
		panic(err)
	}
	return value
}
func encode(value any) []byte     { return must(codec.Marshal(value)) }
func signing(payload node) []byte { return append(append([]byte{}, domain...), encode(payload)...) }
func aad(envelope node) []byte {
	return append(append([]byte{}, aadDomain...), encode(node{"aad": envelope["aad"], "enc": envelope["enc"], "suite": envelope["suite"], "version": envelope["version"]})...)
}
func binary(value any) []byte { b, _ := value.([]byte); return b }
func object(value any) node   { m, _ := value.(map[string]any); return m }
func text(value any) string   { s, _ := value.(string); return s }
func validData(value any) bool {
	switch v := value.(type) {
	case nil, bool, string, []byte:
		return true
	case int64:
		return v >= -9007199254740991 && v <= 9007199254740991
	case uint64:
		return v <= 9007199254740991
	case []any:
		for _, x := range v {
			if !validData(x) {
				return false
			}
		}
		return true
	case map[string]any:
		if _, exists := v["$bytes"]; exists {
			return false
		}
		if _, exists := v["$link"]; exists {
			return false
		}
		for _, x := range v {
			if !validData(x) {
				return false
			}
		}
		return true
	default:
		return false
	}
}
func canonical(raw []byte) (any, error) {
	var value any
	if err := decoder.Unmarshal(raw, &value); err != nil {
		return nil, err
	}
	if !validData(value) || !bytes.Equal(raw, encode(value)) {
		return nil, failure
	}
	return value, nil
}
func supported(n node) bool {
	return bytes.Equal(encode(n["version"]), []byte{1}) && bytes.Equal(encode(n["suite"]), encode(suiteNode))
}
func validAad(n node) bool {
	return n != nil && validData(n) && did.MatchString(text(n["senderDid"])) && did.MatchString(text(n["recipientDid"])) && tid.MatchString(text(n["messageId"])) && text(n["recipientKeyId"]) != "" && validDate(n, "expiresAt")
}
func validDate(n node, key string) bool {
	v, exists := n[key]
	if !exists {
		return true
	}
	_, err := time.Parse(time.RFC3339Nano, text(v))
	return err == nil
}
func validPayload(n node) bool {
	if n == nil || !validData(n) || !supported(n) || !validAad(object(n["aad"])) || !validDate(n, "createdAt") {
		return false
	}
	if _, ok := n["body"].([]byte); !ok {
		return false
	}
	if v, ok := n["urgent"]; ok && v != true {
		return false
	}
	if v, ok := n["replyTo"]; ok {
		ref := object(v)
		if ref == nil || !did.MatchString(text(ref["senderDid"])) || !tid.MatchString(text(ref["messageId"])) {
			return false
		}
		if _, ok := ref["cid"]; ok {
			return false
		}
		if _, ok := ref["uri"]; ok {
			return false
		}
	}
	return true
}

// Scalars are public, invented fixture keys, never runtime keys.
func signingKey() *ecdsa.PrivateKey {
	d := big.NewInt(7)
	x, y := elliptic.P256().ScalarBaseMult(d.FillBytes(make([]byte, 32)))
	return &ecdsa.PrivateKey{PublicKey: ecdsa.PublicKey{Curve: elliptic.P256(), X: x, Y: y}, D: d}
}
func recipientSecret() []byte { return big.NewInt(11).FillBytes(make([]byte, 32)) }
func signature(raw []byte) []byte {
	digest := sha256.Sum256(raw)
	r, s := mustSignature(ecdsa.Sign(rand.Reader, signingKey(), digest[:]))
	half := new(big.Int).Rsh(new(big.Int).Set(elliptic.P256().Params().N), 1)
	if s.Cmp(half) > 0 {
		s.Sub(elliptic.P256().Params().N, s)
	}
	return append(r.FillBytes(make([]byte, 32)), s.FillBytes(make([]byte, 32))...)
}
func mustSignature(r, s *big.Int, err error) (*big.Int, *big.Int) {
	if err != nil {
		panic(err)
	}
	return r, s
}
func verifySignature(raw, sig []byte) bool {
	if len(sig) != 64 {
		return false
	}
	r := new(big.Int).SetBytes(sig[:32])
	s := new(big.Int).SetBytes(sig[32:])
	order := elliptic.P256().Params().N
	if r.Sign() <= 0 || r.Cmp(order) >= 0 || s.Sign() <= 0 || s.Cmp(new(big.Int).Rsh(new(big.Int).Set(order), 1)) > 0 {
		return false
	}
	digest := sha256.Sum256(raw)
	return ecdsa.Verify(&signingKey().PublicKey, digest[:], r, s)
}
func encrypt(payload node, plaintext []byte) node {
	sk := must(hpke.KEM_P256_HKDF_SHA256.Scheme().UnmarshalBinaryPrivateKey(recipientSecret()))
	sender := must(suite.NewSender(sk.Public(), info))
	enc, sealer, err := sender.Setup(rand.Reader)
	if err != nil {
		panic(err)
	}
	e := node{"aad": payload["aad"], "enc": enc, "suite": payload["suite"], "version": payload["version"]}
	e["ciphertext"] = must(sealer.Seal(plaintext, aad(e)))
	return e
}
func seal(payload node) node {
	if !validPayload(payload) {
		panic("invalid generator payload")
	}
	a := object(payload["aad"])
	raw := signing(payload)
	return encrypt(payload, encode(node{"appSignature": node{"algorithm": "ES256", "keyId": text(a["senderDid"]) + "#atproto", "signature": signature(raw)}, "canonicalSigningBytes": raw}))
}
func open(e node) (node, error) {
	a := object(e["aad"])
	if e == nil || !validData(e) || !supported(e) || !validAad(a) || !strings.HasPrefix(text(a["recipientKeyId"]), text(a["recipientDid"])+"#") {
		return nil, failure
	}
	sk := must(hpke.KEM_P256_HKDF_SHA256.Scheme().UnmarshalBinaryPrivateKey(recipientSecret()))
	receiver, err := suite.NewReceiver(sk, info)
	if err != nil {
		return nil, err
	}
	opener, err := receiver.Setup(binary(e["enc"]))
	if err != nil {
		return nil, err
	}
	raw, err := opener.Open(binary(e["ciphertext"]), aad(e))
	if err != nil {
		return nil, err
	}
	value, err := canonical(raw)
	if err != nil {
		return nil, err
	}
	signed := object(value)
	sb := binary(signed["canonicalSigningBytes"])
	if !bytes.HasPrefix(sb, domain) {
		return nil, failure
	}
	value, err = canonical(sb[len(domain):])
	if err != nil {
		return nil, err
	}
	payload := object(value)
	if !validPayload(payload) {
		return nil, failure
	}
	for _, key := range []string{"aad", "suite", "version"} {
		if !bytes.Equal(encode(payload[key]), encode(e[key])) {
			return nil, failure
		}
	}
	app := object(signed["appSignature"])
	if text(app["algorithm"]) != "ES256" || text(app["keyId"]) != text(a["senderDid"])+"#atproto" || !verifySignature(sb, binary(app["signature"])) {
		return nil, failure
	}
	return payload, nil
}

// The wire boundary uses atproto byte wrappers, not Go's JSON base64 shorthand.
func fromWire(v any) any {
	switch n := v.(type) {
	case json.Number:
		return must(n.Int64())
	case []any:
		for i, x := range n {
			n[i] = fromWire(x)
		}
		return n
	case map[string]any:
		if b, ok := n["$bytes"]; ok {
			if len(n) != 1 {
				panic("malformed bytes")
			}
			return must(base64.StdEncoding.DecodeString(text(b)))
		}
		for k, x := range n {
			n[k] = fromWire(x)
		}
		return n
	default:
		return n
	}
}
func toWire(v any) any {
	switch n := v.(type) {
	case []node:
		r := make([]any, len(n))
		for i, x := range n {
			r[i] = toWire(x)
		}
		return r
	case []byte:
		return node{"$bytes": base64.StdEncoding.EncodeToString(n)}
	case []any:
		r := make([]any, len(n))
		for i, x := range n {
			r[i] = toWire(x)
		}
		return r
	case map[string]any:
		r := node{}
		for k, x := range n {
			r[k] = toWire(x)
		}
		return r
	default:
		return n
	}
}
func malformed() []node {
	cases := []struct{ name, hex string }{
		{"nonminimal integer", "1801"}, {"indefinite map", "bfff"}, {"duplicate key", "a2616101616102"}, {"unsorted keys", "a2616201616102"}, {"truncated bytes", "4200"}, {"trailing value", "0101"}, {"float", "fa3f800000"}, {"undefined", "f7"}, {"nonstring key", "a10101"}, {"invalid utf8", "61ff"}, {"tag", "c001"}, {"nonminimal length", "780161"},
	}
	result := []node{}
	for _, c := range cases {
		raw := must(hex.DecodeString(c.hex))
		_, err := canonical(raw)
		if err == nil {
			panic("bad rejection vector")
		}
		result = append(result, node{"name": c.name, "bytes": raw, "accepted": false})
	}
	return result
}
func generate(payloads []any) node {
	vectors := []node{}
	for _, v := range payloads {
		p := object(v)
		e := seal(p)
		opened, err := open(e)
		if err != nil || !reflect.DeepEqual(opened, p) {
			panic("Go self-open failed")
		}
		bad := []node{}
		// Authentic HPKE with broken inner CBOR/signature exercises more than the AEAD fence.
		sb := signing(p)
		sig := signature(sb)
		keyID := text(object(p["aad"])["senderDid"]) + "#atproto"
		signed := node{"appSignature": node{"algorithm": "ES256", "keyId": keyID, "signature": sig}, "canonicalSigningBytes": sb}
		for _, c := range malformed() {
			bad = append(bad, node{"name": c["name"], "envelope": encrypt(p, binary(c["bytes"]))})
		}
		broken := append([]byte{}, sb...)
		broken[0] ^= 1
		signed["canonicalSigningBytes"] = broken
		bad = append(bad, node{"name": "signature domain", "envelope": encrypt(p, encode(signed))})
		signed["canonicalSigningBytes"] = sb
		high := append([]byte{}, sig...)
		new(big.Int).Sub(elliptic.P256().Params().N, new(big.Int).SetBytes(sig[32:])).FillBytes(high[32:])
		object(signed["appSignature"])["signature"] = high
		bad = append(bad, node{"name": "high S", "envelope": encrypt(p, encode(signed))})
		// A valid low-S signature over a nonminimal payload map must still fail.
		payloadCBOR := encode(p)
		nonminimal := append([]byte{0xb8, payloadCBOR[0] & 31}, payloadCBOR[1:]...)
		noncanonicalSigning := append(append([]byte{}, domain...), nonminimal...)
		signed["canonicalSigningBytes"] = noncanonicalSigning
		object(signed["appSignature"])["signature"] = signature(noncanonicalSigning)
		bad = append(bad, node{"name": "noncanonical signed payload", "envelope": encrypt(p, encode(signed))})
		// Correct signature, but the inner AAD differs from the authenticated header.
		otherPayload := node{}
		for k, v := range p {
			otherPayload[k] = v
		}
		otherAad := node{}
		for k, v := range object(p["aad"]) {
			otherAad[k] = v
		}
		otherAad["future"] = "changed"
		otherPayload["aad"] = otherAad
		signed["canonicalSigningBytes"] = signing(otherPayload)
		object(signed["appSignature"])["signature"] = signature(signing(otherPayload))
		bad = append(bad, node{"name": "inner metadata mismatch", "envelope": encrypt(p, encode(signed))})
		for _, b := range bad {
			if _, err := open(object(b["envelope"])); err == nil {
				panic("Go accepted rejection")
			}
		}
		vectors = append(vectors, node{"payload": p, "envelope": e, "signingBytes": signing(p), "aadBytes": aad(e), "reject": bad})
	}
	sk := must(hpke.KEM_P256_HKDF_SHA256.Scheme().UnmarshalBinaryPrivateKey(recipientSecret()))
	return node{"implementation": "Go / circl v1.6.1 / fxamacker CBOR v2.9.0 / stdlib ECDSA", "info": info, "signingPublic": elliptic.Marshal(elliptic.P256(), signingKey().X, signingKey().Y), "recipientPublic": must(sk.Public().MarshalBinary()), "recipientPrivate": recipientSecret(), "signingPrivate": signingKey().D.FillBytes(make([]byte, 32)), "vectors": vectors, "canonicalReject": malformed()}
}
func run() error {
	codec = must(cbor.CanonicalEncOptions().EncMode())
	decoder = must((cbor.DecOptions{DupMapKey: cbor.DupMapKeyEnforcedAPF, IndefLength: cbor.IndefLengthForbidden, TagsMd: cbor.TagsForbidden, DefaultMapType: reflect.TypeOf(map[string]any{}), IntDec: cbor.IntDecConvertSigned}).DecMode())
	if len(os.Args) != 2 {
		return errors.New("usage: envelope-xcheck generate|verify < input.json")
	}
	raw := must(io.ReadAll(os.Stdin))
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var input any
	if err := dec.Decode(&input); err != nil {
		return err
	}
	input = fromWire(input)
	switch os.Args[1] {
	case "generate":
		return json.NewEncoder(os.Stdout).Encode(toWire(generate(input.([]any))))
	case "verify":
		count := 0
		for _, v := range input.([]any) {
			row := object(v)
			got, err := open(object(row["envelope"]))
			accepted := err == nil
			want, _ := row["accepted"].(bool)
			if accepted != want {
				return fmt.Errorf("acceptance disagreement at %d: Go %v TS %v (%v)", count, accepted, want, err)
			}
			if accepted && !bytes.Equal(encode(got), encode(row["payload"])) {
				return fmt.Errorf("payload disagreement at %d", count)
			}
			count++
		}
		return json.NewEncoder(os.Stdout).Encode(node{"verified": count})
	default:
		return errors.New("unknown mode")
	}
}
func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
