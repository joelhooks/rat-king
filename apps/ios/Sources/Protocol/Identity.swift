import CryptoKit
import Foundation
import Security

struct DIDDocument: Sendable {
    let value: Value
    init(_ value: Value) throws {
        guard !Self.containsPrivateMaterial(value) else { throw ProtocolError.invalid("Refusing private key material in a public document") }
        guard try value.required("id").text.hasPrefix("did:web:") else { throw ProtocolError.invalid("Only did:web is supported") }
        _ = try value.required("verificationMethod").list()
        _ = try value.required("authentication").list()
        _ = try value.required("keyAgreement").list()
        self.value = value
    }
    private static func containsPrivateMaterial(_ value: Value) -> Bool {
        switch value {
        case let .map(m): return m.contains { key, child in
            ["d", "p", "q", "dp", "dq", "qi", "oth", "k", "seed", "secret", "privatekey", "private_key", "privatescalar", "private_scalar"].contains(key.lowercased()) || containsPrivateMaterial(child)
        }
        case let .array(a): return a.contains(where: containsPrivateMaterial)
        case let .string(s): return s.contains("-----BEGIN") && s.contains("PRIVATE KEY-----")
        default: return false
        }
    }
    var did: String { get throws { try value.required("id").text } }
    func point(keyId: String, purpose: String) throws -> Data {
        let did = try self.did
        guard keyId.hasPrefix(did + "#"), try value.required(purpose).list().contains(.string(keyId)),
              let method = try value.required("verificationMethod").list().first(where: { $0["id"] == .string(keyId) && $0["controller"] == .string(did) }) else { throw ProtocolError.invalid("Unauthorized DID key") }
        let jwk = try method.required("publicKeyJwk")
        guard jwk["kty"] == .string("EC"), jwk["crv"] == .string("P-256"), jwk["d"] == nil else { throw ProtocolError.invalid("Expected public P-256 JWK") }
        let x = try Data(base64url: jwk.required("x").text), y = try Data(base64url: jwk.required("y").text)
        guard x.count == 32, y.count == 32 else { throw ProtocolError.invalid("Invalid P-256 coordinates") }; return Data([4]) + x + y
    }
    func encryptionKey() throws -> (String, P256.KeyAgreement.PublicKey) {
        for id in try value.required("keyAgreement").list() {
            let keyId = try id.text
            if let key = try? P256.KeyAgreement.PublicKey(x963Representation: point(keyId: keyId, purpose: "keyAgreement")) { return (keyId, key) }
        }
        throw ProtocolError.invalid("No authorized encryption key")
    }
    func signingKey(_ id: String) throws -> P256.Signing.PublicKey { try P256.Signing.PublicKey(x963Representation: point(keyId: id, purpose: "authentication")) }
}

// dataRepresentation is an SE-wrapped reference, NOT a plaintext private scalar.
// Keychain device-only storage prevents iCloud sync and restoration onto another phone.
struct PhoneIdentity: Sendable {
    let did: String
    let encryption: SecureEnclave.P256.KeyAgreement.PrivateKey
    let signing: SecureEnclave.P256.Signing.PrivateKey
    var encryptionId: String { did + "#encryption" }
    var signingId: String { did + "#atproto" }
    init(did: String) throws {
        guard did.hasPrefix("did:web:"), SecureEnclave.isAvailable else { throw ProtocolError.invalid("Secure Enclave unavailable. Identity creation requires a physical device; no software fallback.") }
        self.did = did
        let prefix = (Bundle.main.bundleIdentifier ?? "ratking") + ".identity."
        let service = prefix + "device"
        let stable = try Self.load(service)
        let current = try Self.load(prefix + did)
        let record = try IdentityReferences.select(stable: stable, current: current, legacy: stable == nil ? Self.legacy(prefix: prefix, excluding: service) : [])
        if let record {
            let keys = try Value.json(record)
            encryption = try SecureEnclave.P256.KeyAgreement.PrivateKey(dataRepresentation: keys.required("encryption").data)
            signing = try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: keys.required("signing").data)
            if stable == nil { try Self.save(record, service: service) }
        } else {
            encryption = try SecureEnclave.P256.KeyAgreement.PrivateKey()
            signing = try SecureEnclave.P256.Signing.PrivateKey()
            let data = try Value.map(["encryption": .bytes(encryption.dataRepresentation), "signing": .bytes(signing.dataRepresentation)]).jsonData()
            try Self.save(data, service: service)
        }
    }
    private static func save(_ data: Data, service: String) throws {
        let status = SecItemAdd([kSecClass: kSecClassGenericPassword, kSecAttrService: service, kSecAttrAccount: "keys", kSecValueData: data, kSecAttrAccessible: kSecAttrAccessibleWhenUnlockedThisDeviceOnly] as CFDictionary, nil)
        if status == errSecDuplicateItem, try load(service) == data { return }
        guard status == errSecSuccess else { throw ProtocolError.invalid("Cannot save device identity (\(status)); refusing to replace keys") }
    }
    private static func legacy(prefix: String, excluding: String) throws -> [Data] {
        var result: CFTypeRef?
        let status = SecItemCopyMatching([kSecClass: kSecClassGenericPassword, kSecAttrAccount: "keys", kSecReturnAttributes: true, kSecReturnData: true, kSecMatchLimit: kSecMatchLimitAll] as CFDictionary, &result)
        if status == errSecItemNotFound { return [] }
        guard status == errSecSuccess, let records = result as? [[String: Any]] else { throw ProtocolError.invalid("Cannot inspect prior device identities (\(status)); refusing to rotate keys") }
        return try records.compactMap { row in
            guard let service = row[kSecAttrService as String] as? String, service.hasPrefix(prefix), service != excluding else { return nil }
            guard let data = row[kSecValueData as String] as? Data else { throw ProtocolError.invalid("Unreadable prior identity; refusing to rotate keys") }
            return data
        }
    }
    private static func load(_ service: String) throws -> Data? {
        var result: CFTypeRef?
        let status = SecItemCopyMatching([kSecClass: kSecClassGenericPassword, kSecAttrService: service, kSecAttrAccount: "keys", kSecReturnData: true, kSecMatchLimit: kSecMatchLimitOne] as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else { throw ProtocolError.invalid("Cannot load identity (\(status)); refusing to rotate keys") }; return data
    }
    func sign(_ data: Data) throws -> Data { try ES256.normalize(signing.signature(for: data).rawRepresentation) }
    var document: Value {
        func jwk(_ point: Data) -> Value { .map(["kty": .string("EC"), "crv": .string("P-256"), "x": .string(Data(point.dropFirst().prefix(32)).base64url), "y": .string(Data(point.suffix(32)).base64url)]) }
        return .map(["id": .string(did), "authentication": .array([.string(signingId)]), "keyAgreement": .array([.string(encryptionId)]), "verificationMethod": .array([
            .map(["id": .string(signingId), "controller": .string(did), "publicKeyJwk": jwk(signing.publicKey.x963Representation)]),
            .map(["id": .string(encryptionId), "controller": .string(did), "publicKeyJwk": jwk(encryption.publicKey.x963Representation)])
        ])])
    }
    func token(audience: String, method: String) throws -> String {
        let now = Int64(Date().timeIntervalSince1970)
        let header = try Value.map(["alg": .string("ES256"), "typ": .string("JWT"), "kid": .string(signingId)]).jsonData().base64url
        let claims = try Value.map(["iss": .string(did), "aud": .string(audience), "lxm": .string(method), "iat": .int(now), "exp": .int(now+60), "jti": .string(UUID().uuidString)]).jsonData().base64url
        let bytes = Data("\(header).\(claims)".utf8)
        return "\(header).\(claims).\(try sign(bytes).base64url)"
    }
}
