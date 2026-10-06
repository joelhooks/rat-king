import Foundation

// Select wrapped Secure Enclave references, never scalars. Migration is additive:
// the stable slot survives DID changes and old DID slots remain for rollback.
enum IdentityReferences {
    static func select(stable: Data?, current: Data?, legacy: [Data]) throws -> Data? {
        if let stable {
            if let current, current != stable { throw ProtocolError.invalid("Conflicting device identity; refusing to rotate keys") }
            return stable
        }
        let unique = Set(legacy + (current.map { [$0] } ?? []))
        guard unique.count <= 1 else { throw ProtocolError.invalid("Multiple prior device identities; refusing to choose or generate keys") }
        return unique.first
    }
}
