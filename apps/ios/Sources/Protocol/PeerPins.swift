import Foundation

// The authenticated mailbox supplies documents; a DID pins on first sight.
// Replacement is explicit, whether from Files or the review in Identity.
struct PeerPins {
    private(set) var documents: [String: DIDDocument] = [:]
    private(set) var changes: [String: DIDDocument] = [:]
    mutating func observe(_ value: Value, expected: String? = nil) throws {
        let document = try Self.validate(value)
        let did = try document.did
        guard expected == nil || expected == did else { throw ProtocolError.invalid("Peer lookup DID mismatch") }
        // A previously observed change stays blocked even if a later lookup
        // reverts. Only explicit acceptance clears the review requirement.
        if let pinned = documents[did], pinned.value != value || changes[did] != nil {
            changes[did] = document
            throw ProtocolError.invalid("Peer document changed for \(did). Review and accept in Identity before verifying or replying.")
        }
        documents[did] = document; changes.removeValue(forKey: did)
    }
    mutating func accept(_ value: Value) throws {
        let document = try Self.validate(value), did = try document.did
        documents[did] = document; changes.removeValue(forKey: did)
    }
    static func validate(_ value: Value) throws -> DIDDocument {
        let document = try DIDDocument(value)
        _ = try document.encryptionKey()
        let ids = try value.required("authentication").list()
        guard !ids.isEmpty else { throw ProtocolError.invalid("Peer has no signing key") }
        for id in ids { _ = try document.signingKey(id.text) }
        return document
    }
}
