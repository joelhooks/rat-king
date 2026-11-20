import CryptoKit
import XCTest
@testable import RatKing

final class PublicDocumentTests: XCTestCase {
    func testPublicDocumentRoundTripsOnlyPublicMaterialForEachPhone() throws {
        for index in 0..<64 {
            let did = "did:web:sample-phone-\(index).example.invalid"
            let sign = P256.Signing.PrivateKey().publicKey
            let agree = P256.KeyAgreement.PrivateKey().publicKey
            let value = PhoneIdentity.publicDocument(did: did, signing: sign, encryption: agree)
            let decoded = try Value.json(value.jsonData())
            XCTAssertEqual(Set(try decoded.object().keys), ["id", "authentication", "keyAgreement", "verificationMethod"])
            for method in try decoded.required("verificationMethod").list() {
                XCTAssertEqual(Set(try method.object().keys), ["id", "controller", "publicKeyJwk"])
                XCTAssertEqual(Set(try method.required("publicKeyJwk").object().keys), ["kty", "crv", "x", "y"])
            }
            let document = try DIDDocument(decoded)
            XCTAssertEqual(try document.did, did)
            XCTAssertEqual(try document.signingKey(did + "#atproto").x963Representation, sign.x963Representation)
            XCTAssertEqual(try document.encryptionKey().1.x963Representation, agree.x963Representation)
        }
    }
}
