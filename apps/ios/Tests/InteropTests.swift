import XCTest
import CryptoKit
@testable import RatKing

final class InteropTests: XCTestCase {
    private func fixture(_ name: String) throws -> Value {
        let bundle = Bundle(for: Self.self)
        guard let url = bundle.url(forResource: name, withExtension: "json") ?? bundle.url(forResource: name, withExtension: "json", subdirectory: "vectors/xcheck") else { throw ProtocolError.invalid("Missing vector \(name)") }
        return try Value.json(Data(contentsOf: url))
    }
    // Software keys below are published synthetic vectors only. No phone key export exists.
    func testExistingEnvelopeVectors() throws {
        let go = try fixture("go")
        let recipient = try P256.KeyAgreement.PrivateKey(rawRepresentation: go.required("recipientPrivate").data)
        let signing = try P256.Signing.PublicKey(x963Representation: go.required("signingPublic").data)
        func open(_ e: Value) throws -> Value {
            try Envelope.open(e, did: "did:web:recipient.example.invalid", keyId: "did:web:recipient.example.invalid#encryption", key: recipient) { _, _ in signing }
        }
        for vector in try go.required("vectors").list() {
            let e = try vector.required("envelope"), payload = try vector.required("payload")
            XCTAssertEqual(try open(e), payload)
            XCTAssertEqual(Envelope.signatureDomain + CBOR.encode(payload), try vector.required("signingBytes").data)
            XCTAssertEqual(Envelope.aadDomain + CBOR.encode(try Envelope.header(e)), try vector.required("aadBytes").data)
            for rejected in try vector.required("reject").list() { XCTAssertThrowsError(try open(rejected.required("envelope"))) }
        }
        for rejected in try go.required("canonicalReject").list() { XCTAssertThrowsError(try CBOR.decode(rejected.required("bytes").data)) }
        for vector in try fixture("ts").list() {
            let e = try vector.required("envelope")
            if vector["accepted"] == .bool(true) { XCTAssertEqual(try open(e), try vector.required("payload")) }
            else { XCTAssertThrowsError(try open(e)) }
        }
    }
    func testSwiftSealedEnvelopeForTypeScript() throws {
        let go = try fixture("go")
        let signing = try P256.Signing.PrivateKey(rawRepresentation: go.required("signingPrivate").data)
        let recipient = try P256.KeyAgreement.PublicKey(x963Representation: go.required("recipientPublic").data)
        let vector = try go.required("vectors").list()[0], payload = try vector.required("payload")
        let e = try Envelope.seal(payload: payload, signingKeyId: "did:web:sender.example.invalid#atproto", sign: { try signing.signature(for: $0).rawRepresentation }, recipient: recipient)
        let wire = try Value.map(["envelope": e, "payload": payload]).jsonData()
        // Runner extracts this public synthetic vector from the simulator's test log.
        print("RK_SWIFT_VECTOR=" + wire.base64EncodedString())
    }
    func testRFCHPKEVector() throws {
        let bundle = Bundle(for: Self.self)
        let url = try XCTUnwrap(bundle.url(forResource: "rfc9180-p256-sha256-aes128gcm-base", withExtension: "json", subdirectory: "vectors"))
        let v = try Value.json(Data(contentsOf: url)).list()[0]
        func hex(_ name: String) throws -> Data {
            let s = Array(try v.required(name).text); var d = Data()
            for i in stride(from: 0, to: s.count, by: 2) { d.append(try XCTUnwrap(UInt8(String(s[i...i+1]), radix: 16))) }; return d
        }
        let key = try P256.KeyAgreement.PrivateKey(rawRepresentation: hex("skRm"))
        var recipient = try HPKE.Recipient(privateKey: key, ciphersuite: Envelope.cipher, info: hex("info"), encapsulatedKey: hex("enc"))
        for encryption in try v.required("encryptions").list() {
            func bytes(_ name: String) throws -> Data {
                let s = Array(try encryption.required(name).text); var d = Data()
                for i in stride(from: 0, to: s.count, by: 2) { d.append(try XCTUnwrap(UInt8(String(s[i...i+1]), radix: 16))) }; return d
            }
            XCTAssertEqual(try recipient.open(bytes("ct"), authenticating: bytes("aad")), try bytes("pt"))
        }
    }
}
