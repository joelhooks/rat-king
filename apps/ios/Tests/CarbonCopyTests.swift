import XCTest
import CryptoKit
@testable import RatKing

final class CarbonCopyTests: XCTestCase {
    private let sender = "did:web:sender.example.invalid", recipient = "did:web:recipient.example.invalid"
    private let primaryId = "3m5abcde23456", copyId = "3m5abcde23457"
    private func payload(_ mutation: Int = 0, content: String = "copy content") throws -> Value {
        var primary: [String: Value] = ["senderDid": .string(sender), "recipientDid": .string(recipient), "messageId": .string(primaryId)]
        var reply: [String: Value] = ["senderDid": .string(sender), "messageId": .string(primaryId)]
        if mutation == 1 { primary["senderDid"] = .string("did:web:impostor.example.invalid") }
        if mutation == 2 { reply["messageId"] = .string(copyId) }
        if mutation == 3 { reply["senderDid"] = .string("did:web:impostor.example.invalid") }
        if mutation == 4 { primary.removeValue(forKey: "messageId") }
        return .map(["aad": .map(["senderDid": .string(sender), "recipientDid": .string("did:web:phone.example.invalid"), "messageId": .string(copyId)]),
                     "replyTo": .map(reply), "body": .bytes(try Value.map(["$type": .string(CarbonCopy.marker), "body": .string(content), "primary": .map(primary)]).jsonData())])
    }
    private func entry(sender: String? = nil, recipient: String? = nil, tid: String? = nil) throws -> TrafficEntry {
        try TrafficEntry(.map(["seq": .int(1), "recipientSeq": .int(1), "time": .string("2026-01-01T12:00:00.000Z"),
            "senderDid": .string(sender ?? self.sender), "recipientDid": .string(recipient ?? self.recipient), "messageId": .string(tid ?? primaryId), "ciphertextSize": .int(1024), "state": .string("accepted")]))
    }
    @MainActor func testGeneratedCopyRoutingNeverEntersMailOrCountsAsPrimaryDelivery() async throws {
        let primary = try entry()
        let copyTraffic = try entry(recipient: "did:web:phone.example.invalid", tid: copyId)
        let foreignPrimary = try entry(sender: "did:web:other.example.invalid")
        let detail = TrafficDetail(selected: primary, entries: [primary, copyTraffic, foreignPrimary])
        XCTAssertEqual(detail.events, [primary])
        for index in 0..<100 {
            let mutation = index % 5
            let opened = try payload(mutation, content: "{\"$type\":\"sh.mschf.ratking.desk.answer\",\"note\":\"synthetic \(index)\"}")
            let route = try OpenedPhoneMessage.route(opened, message: .map(["senderDid": .string(sender), "messageId": .string(copyId)]), time: "synthetic time", receipt: "accepted")
            guard case let .copy(copy) = route else { return XCTFail("CC reached Mail and desk routing") }
            XCTAssertEqual(copy.matches(primary), mutation == 0)
            for mismatch in [try entry(sender: "did:web:other.example.invalid"), try entry(recipient: "did:web:other.example.invalid"), try entry(tid: copyId)] {
                XCTAssertFalse(copy.matches(mismatch))
            }
            XCTAssertEqual(try CarbonCopy(Value.json(copy.wire.jsonData())), copy)
            var calls: [String] = []
            let received = try await copy.receive { operation, ref in
                XCTAssertEqual(ref, copy.message)
                XCTAssertNotEqual(try ref.required("messageId").text, self.primaryId)
                calls.append(operation); return operation == "deliver" ? "delivered" : "acked"
            }
            XCTAssertEqual(received, "acked"); XCTAssertEqual(calls, ["deliver", "ack"])
            XCTAssertEqual(primary.state, "accepted")
        }
        var malformed = try payload().object()
        malformed["body"] = .bytes(Data("{\"$type\":\"sh.mschf.ratking.mailbox.cc\",\"future\":1.5}".utf8))
        guard case let .copy(unlinked) = try OpenedPhoneMessage.route(.map(malformed), message: .map(["senderDid": .string(sender), "messageId": .string(copyId)]), time: "time", receipt: "accepted") else { return XCTFail("Malformed marker reached Mail") }
        XCTAssertFalse(unlinked.linkValid)
        var plain = try payload().object(); plain["body"] = .bytes(Data("ordinary mail".utf8))
        guard case let .mail(item) = try OpenedPhoneMessage.route(.map(plain), message: .map(["senderDid": .string(sender), "messageId": .string(primaryId)]), time: "time", receipt: "accepted") else { return XCTFail("Plain mail lost") }
        XCTAssertEqual(item.text, "ordinary mail")
    }
    func testActualTSClientV1CopyOpensWithSignedMarkerAndRejectsTampering() throws {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "cc-v1", withExtension: "json"))
        let fixture = try Value.json(Data(contentsOf: url))
        func base64url(_ value: Value) throws -> Data {
            var text = try value.text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
            while text.count % 4 != 0 { text += "=" }
            return try XCTUnwrap(Data(base64Encoded: text))
        }
        let agreement = try fixture.required("phoneAgreement"), signing = try fixture.required("senderSigning")
        let key = try P256.KeyAgreement.PrivateKey(rawRepresentation: base64url(agreement.required("d")))
        let publicKey = try P256.Signing.PublicKey(x963Representation: Data([4]) + base64url(signing.required("x")) + base64url(signing.required("y")))
        let envelope = try fixture.required("envelope")
        func open(_ envelope: Value, resolve: (String, String) throws -> P256.Signing.PublicKey) throws -> Value {
            try Envelope.open(envelope, did: "did:web:phone.example.invalid", keyId: "did:web:phone.example.invalid#encryption", key: key, resolve: resolve)
        }
        let opened = try open(envelope) { did, id in
            XCTAssertEqual(did, self.sender); XCTAssertEqual(id, self.sender + "#atproto"); return publicKey
        }
        let copy = try XCTUnwrap(CarbonCopy.decode(opened, time: "synthetic time", receipt: "accepted"))
        XCTAssertTrue(copy.linkValid); XCTAssertEqual(copy.text, "Synthetic CC content from TS client v1")
        XCTAssertEqual(try opened.required("replyTo").required("messageId"), try fixture.required("primary").required("messageId"))
        XCTAssertEqual(copy.primaryMessageId, try fixture.required("primary").required("messageId").text)
        var changed = try envelope.object(); var cipher = try envelope.required("ciphertext").data; cipher[0] ^= 1; changed["ciphertext"] = .bytes(cipher)
        XCTAssertThrowsError(try open(.map(changed)) { _, _ in publicKey })
        XCTAssertThrowsError(try open(envelope) { _, _ in throw ProtocolError.invalid("Untrusted sender") })
    }
}
