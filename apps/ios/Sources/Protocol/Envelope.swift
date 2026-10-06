import CryptoKit
import Foundation

enum ES256 {
    static let order: [UInt8] = [0xff,0xff,0xff,0xff,0,0,0,0,0xff,0xff,0xff,0xff,0xff,0xff,0xff,0xff,0xbc,0xe6,0xfa,0xad,0xa7,0x17,0x9e,0x84,0xf3,0xb9,0xca,0xc2,0xfc,0x63,0x25,0x51]
    static let half: [UInt8] = {
        var carry: UInt8 = 0
        return order.map { b in let v = (b >> 1) | carry; carry = (b & 1) << 7; return v }
    }()
    static func lowS(_ d: Data) -> Bool {
        guard d.count == 64 else { return false }
        let r = Array(d.prefix(32)), s = Array(d.suffix(32))
        return r.contains(where: { $0 != 0 }) && r.lexicographicallyPrecedes(order) && s.contains(where: { $0 != 0 }) && !half.lexicographicallyPrecedes(s)
    }
    static func normalize(_ d: Data) throws -> Data {
        guard d.count == 64 else { throw ProtocolError.invalid("ES256 length") }
        let s = Array(d.suffix(32)); var result = s
        if half.lexicographicallyPrecedes(s) {
            var borrow = 0
            for i in (0..<32).reversed() { let v = Int(order[i]) - Int(s[i]) - borrow; result[i] = UInt8(truncatingIfNeeded: v); borrow = v < 0 ? 1 : 0 }
        }
        let normalized = Data(d.prefix(32)) + Data(result)
        guard lowS(normalized) else { throw ProtocolError.invalid("Invalid ES256 scalar") }; return normalized
    }
}

enum Envelope {
    static let suite: Value = .map(["kemId": .int(16), "kdfId": .int(1), "aeadId": .int(1)])
    static let cipher = HPKE.Ciphersuite(kem: .P256_HKDF_SHA256, kdf: .HKDF_SHA256, aead: .AES_GCM_128)
    static let info = Data("sh.mschf.ratking.hpke.v1".utf8)
    static let signatureDomain = Data("sh.mschf.ratking.signature.v1\0".utf8)
    static let aadDomain = Data("sh.mschf.ratking.aad.v1\0".utf8)
    static func header(_ e: Value) throws -> Value {
        .map(["version": try e.required("version"), "suite": try e.required("suite"), "aad": try e.required("aad"), "enc": try e.required("enc")])
    }
    static func metadata(_ e: Value) throws -> Value {
        .map(["version": try e.required("version"), "suite": try e.required("suite"), "aad": try e.required("aad")])
    }
    static func supported(_ e: Value) throws {
        guard try e.required("version") == .int(1), try e.required("suite") == suite else { throw ProtocolError.invalid("Unsupported envelope") }
        let aad = try e.required("aad")
        for name in ["senderDid", "recipientDid"] { guard try aad.required(name).text.hasPrefix("did:web:") else { throw ProtocolError.invalid("Unsupported DID") } }
        _ = try aad.required("messageId").text
        let did = try aad.required("recipientDid").text
        guard try aad.required("recipientKeyId").text.hasPrefix(did + "#") else { throw ProtocolError.invalid("Unauthorized encryption key") }
    }
    static func seal(payload: Value, signingKeyId: String, sign: (Data) throws -> Data, recipient: P256.KeyAgreement.PublicKey) throws -> Value {
        try supported(payload)
        let sender = try payload.required("aad").required("senderDid").text
        guard signingKeyId.hasPrefix(sender + "#") else { throw ProtocolError.invalid("Unauthorized signing key") }
        _ = try payload.required("body").data
        let bytes = signatureDomain + CBOR.encode(payload)
        let signed: Value = .map(["canonicalSigningBytes": .bytes(bytes), "appSignature": .map(["algorithm": .string("ES256"), "keyId": .string(signingKeyId), "signature": .bytes(try ES256.normalize(sign(bytes)))])])
        var senderContext = try HPKE.Sender(recipientKey: recipient, ciphersuite: cipher, info: info)
        var result = try metadata(payload).object()
        result["enc"] = .bytes(senderContext.encapsulatedKey)
        let aad = aadDomain + CBOR.encode(.map(result))
        result["ciphertext"] = .bytes(try senderContext.seal(CBOR.encode(signed), authenticating: aad))
        return .map(result)
    }
    // This generic path accepts both the non-exportable SE recipient and software vector keys.
    static func open<K: HPKEDiffieHellmanPrivateKey>(_ e: Value, did: String, keyId: String, key: K, resolve: (String, String) throws -> P256.Signing.PublicKey) throws -> Value {
        try supported(e)
        let aad = try e.required("aad")
        guard try aad.required("recipientDid").text == did, try aad.required("recipientKeyId").text == keyId else { throw ProtocolError.invalid("Wrong recipient") }
        var recipient = try HPKE.Recipient(privateKey: key, ciphersuite: cipher, info: info, encapsulatedKey: e.required("enc").data)
        let signed = try CBOR.decode(recipient.open(e.required("ciphertext").data, authenticating: aadDomain + CBOR.encode(header(e))))
        let bytes = try signed.required("canonicalSigningBytes").data
        guard bytes.starts(with: signatureDomain) else { throw ProtocolError.invalid("Wrong signature domain") }
        let payload = try CBOR.decode(Data(bytes.dropFirst(signatureDomain.count)))
        try supported(payload)
        guard try metadata(payload) == metadata(e) else { throw ProtocolError.invalid("Inner metadata mismatch") }
        _ = try payload.required("body").data
        let app = try signed.required("appSignature"), sender = try aad.required("senderDid").text
        let signingId = try app.required("keyId").text, signature = try app.required("signature").data
        guard try app.required("algorithm") == .string("ES256"), signingId.hasPrefix(sender + "#"), ES256.lowS(signature) else { throw ProtocolError.invalid("Unauthorized signature") }
        let publicKey = try resolve(sender, signingId)
        guard try publicKey.isValidSignature(P256.Signing.ECDSASignature(rawRepresentation: signature), for: bytes) else { throw ProtocolError.invalid("Invalid application signature") }
        return payload
    }
}
