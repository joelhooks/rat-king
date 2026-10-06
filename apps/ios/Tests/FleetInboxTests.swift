import XCTest
@testable import RatKing

final class FleetInboxTests: XCTestCase {
    private func fixture(_ name: String) throws -> Value {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "desk-" + name, withExtension: "json", subdirectory: "fixtures"))
        return try Value.json(Data(contentsOf: url))
    }
    func testArrivalsRestoreHiddenThreadsButReplayDoesNotAcrossGeneratedCommands() throws {
        let sender = "did:web:sample.example.invalid"
        let key = try inboxThreadKey(sender: sender, project: "sample-project", itemId: "sample-001")
        var seed: UInt64 = 109
        for _ in 0..<100 {
            var messages: [MailItem] = []; var prefs: [String: ThreadPreferences] = [:]
            var modelArchived = false; var modelSnoozed = false; var seen = Set<String>()
            for step in 0..<100 {
                seed = seed &* 6364136223846793005 &+ 1
                switch (seed >> 32) % 5 {
                case 0:
                    var p = prefs[key] ?? ThreadPreferences(); p.archived = true; prefs[key] = p; modelArchived = true
                case 1:
                    var p = prefs[key] ?? ThreadPreferences(); p.snoozedUntil = Date(timeIntervalSince1970: 2_000_000_000); prefs[key] = p; modelSnoozed = true
                default:
                    let name = ["item", "answer", "update"][Int((seed >> 40) % 3)]
                    var record = try fixture(name).object()
                    if name == "update" { record["state"] = .string("followup"); record["text"] = .string("Fresh summary\nSecond line") }
                    let tid = "event-\(step % 13)-\(name)"
                    let mail = MailItem(id: tid, message: .map(["messageId": .string(tid)]), sender: sender, text: String(decoding: try Value.map(record).jsonData(), as: UTF8.self), receipt: "delivered")
                    let fresh = seen.insert(tid).inserted
                    XCTAssertEqual(try appendInboxMessage(mail, messages: &messages, preferences: &prefs), fresh)
                    if fresh { modelArchived = false; modelSnoozed = false }
                    if let thread = try inboxThreads(messages, preferences: prefs).first {
                        XCTAssertEqual(thread.id, key)
                        XCTAssertFalse(thread.summary.contains("\n"))
                        if name == "update", fresh { XCTAssertTrue(thread.summary.hasSuffix("Fresh summary")) }
                    }
                }
                XCTAssertEqual(prefs[key]?.archived ?? false, modelArchived)
                XCTAssertEqual(prefs[key]?.snoozedUntil != nil, modelSnoozed)
            }
        }
        let chat = MailItem(id: "chat", message: .map(["messageId": .string("chat")]), sender: sender, text: "First line\nSecond line", receipt: "delivered")
        let address = try inboxThreadAddress(chat)
        let chatKey = try inboxThreadKey(sender: sender, project: address.project, itemId: address.itemId)
        var hidden = ThreadPreferences(); hidden.archived = true; hidden.snoozedUntil = .distantFuture
        var prefs = [chatKey: hidden]; var messages: [MailItem] = []
        try appendInboxMessage(chat, messages: &messages, preferences: &prefs)
        let thread = try XCTUnwrap(inboxThreads(messages, preferences: prefs).first)
        XCTAssertEqual(thread.summary, sender + " / First line"); XCTAssertFalse(thread.archived); XCTAssertNil(thread.snoozedUntil)
    }
    func testDIDChangesKeepWrappedReferencesAndRefuseAmbiguity() throws {
        for count in 1...256 {
            let old = Data(repeating: UInt8(count % 255), count: count)
            let other = old + Data([255])
            let migrated = try IdentityReferences.select(stable: nil, current: nil, legacy: [old, old])
            XCTAssertEqual(migrated, old)
            XCTAssertEqual(try IdentityReferences.select(stable: migrated, current: nil, legacy: []), old)
            XCTAssertEqual(try IdentityReferences.select(stable: nil, current: old, legacy: [old]), old)
            XCTAssertThrowsError(try IdentityReferences.select(stable: old, current: other, legacy: []))
            XCTAssertThrowsError(try IdentityReferences.select(stable: nil, current: nil, legacy: [old, other]))
            XCTAssertThrowsError(try IdentityReferences.select(stable: nil, current: old, legacy: [other]))
        }
        XCTAssertNil(try IdentityReferences.select(stable: nil, current: nil, legacy: []))
    }
    func testLeaseHeldWaitAndCancellationProjectionAcrossExpiries() throws {
        let did = "did:web:phone.example.invalid", now = Date(timeIntervalSince1970: 1_800_000_000)
        for seconds in 1...300 {
            let wire: Value = .map(["did": .string(did), "leaseId": .string("synthetic"), "generation": .int(1), "expiresAt": .string(ISO8601DateFormatter.fractional.string(from: now.addingTimeInterval(Double(seconds))))])
            let held = try Lease(wire, did: did), wait = LeaseWait(until: held.expiresAt)
            XCTAssertEqual(nextState(nextState(.stopped, .start), .held), .waiting)
            XCTAssertEqual(nextState(.waiting, .background), .stopped)
            XCTAssertEqual(nextState(.waiting, .start), .acquiring)
            for elapsed in [0, seconds / 2, seconds, seconds + 1] {
                let date = now.addingTimeInterval(Double(elapsed)), remaining = max(0, seconds - elapsed)
                XCTAssertEqual(wait.remaining(at: date), remaining)
                XCTAssertEqual(wait.message(at: date), String(format: "waiting for previous session (%d:%02d)", remaining / 60, remaining % 60))
            }
            XCTAssertThrowsError(try Lease(wire, did: "did:web:other.example.invalid"))
        }
        XCTAssertTrue(XRPCError(code: "LeaseHeld", status: 409).isLeaseHeld)
        XCTAssertFalse(XRPCError(code: "LeaseHeld", status: 401).isLeaseHeld)
        XCTAssertFalse(XRPCError(code: "LeaseMismatch", status: 409).isLeaseHeld)
    }
    func testFullSwipeDirectionsAndVerticalScrollProperty() {
        for width in stride(from: 160.0, through: 1000.0, by: 40) {
            for amount in stride(from: 0.0, through: width, by: 8) {
                let reaches = amount >= max(72, width * 0.55)
                XCTAssertEqual(TerminalSwipe.action(horizontal: -amount, vertical: 0, width: width), reaches ? .archive : nil)
                XCTAssertEqual(TerminalSwipe.action(horizontal: amount, vertical: 0, width: width), reaches ? .snooze : nil)
                XCTAssertNil(TerminalSwipe.action(horizontal: amount, vertical: amount, width: width))
                XCTAssertNil(TerminalSwipe.action(horizontal: -amount, vertical: amount * 2, width: width))
            }
        }
    }
    @MainActor func testTransportStoresStaySeparatedAcrossDIDAndAudienceChanges() {
        for count in 0..<100 {
            let did = "did:web:phone-\(count).example.invalid", audience = "did:web:mailbox-\(count).example.invalid#mailbox"
            XCTAssertEqual(InboxStore.scope(did: did, audience: audience), InboxStore.scope(did: did, audience: audience))
            XCTAssertNotEqual(InboxStore.scope(did: did, audience: audience), InboxStore.scope(did: did + "-new", audience: audience))
            XCTAssertNotEqual(InboxStore.scope(did: did, audience: audience), InboxStore.scope(did: did, audience: audience + "-new"))
        }
    }
}
