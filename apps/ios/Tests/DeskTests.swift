import XCTest
@testable import RatKing

final class DeskTests: XCTestCase {
    private func fixture(_ name: String) throws -> Value {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "desk-" + name, withExtension: "json", subdirectory: "fixtures"))
        return try Value.json(Data(contentsOf: url))
    }
    func testSharedCodecFixturesBothWays() throws {
        for name in ["item", "answer", "update"] {
            let raw = try fixture(name), record = try XCTUnwrap(DeskRecord.decode(raw))
            XCTAssertEqual(try Value.json(record.value.jsonData()), raw)
            var extended = try raw.object(); extended["future"] = .map(["opaque": .string("kept")])
            XCTAssertEqual(try DeskRecord.decode(.map(extended))?.value, .map(extended))
        }
        guard case let .item(_, card) = try DeskRecord.decode(fixture("item")) else { return XCTFail("Missing card") }
        let answer = try DeskRecord.answer(card: card, inReplyTo: "3m5abcde23456", values: ["path": "hold"], rows: ["checks": ["codec"]], note: "Keep it reversible.")
        XCTAssertEqual(answer, try fixture("answer"))
        XCTAssertThrowsError(try DeskRecord.answer(card: card, inReplyTo: "3m5abcde23456", values: ["path": "invalid"], rows: [:], note: ""))
        var malformed = try fixture("item").object(); malformed["choices"] = .array([.map(["key": .string("path")])])
        XCTAssertThrowsError(try DeskRecord.decode(.map(malformed)))
        XCTAssertNil(try DeskRecord.decode(.map(["$type": .string("future.record")])))
    }
    func testThreadModelAcrossGeneratedCommandSequences() throws {
        let card = try fixture("item")
        let sender = "did:web:sample.example.invalid"
        func mail(_ tid: String, _ value: Value, _ from: String = "did:web:sample.example.invalid") throws -> MailItem {
            MailItem(id: from + "/" + tid, message: .map(["messageId": .string(tid), "senderDid": .string(from)]), sender: from, text: String(decoding: try value.jsonData(), as: UTF8.self), receipt: "delivered")
        }
        let incoming = try mail("3m5abcde23456", card)
        let key = try XCTUnwrap(inboxThreads([incoming], preferences: [:]).first?.id)
        var seed: UInt64 = 77
        for _ in 0..<100 {
            var messages = [incoming]; var prefs = ThreadPreferences(); var model: ThreadState = .open
            var archived = false; var snoozed = false
            let now = Date(timeIntervalSince1970: 1_800_000_000)
            for step in 0..<50 {
                seed = seed &* 6364136223846793005 &+ 1
                switch (seed >> 32) % 6 {
                case 0: prefs.state = threadState(prefs.state, .answered); if model == .open { model = .sent }
                case 1: prefs.archived = true; archived = true
                case 2: prefs.archived = false; archived = false
                case 3: prefs.snoozedUntil = now.addingTimeInterval(3600); snoozed = true
                case 4, 5:
                    let state = (seed >> 32) % 6 == 4 ? "resolved" : "superseded"
                    var update = try fixture("update").object(); update["state"] = .string(state)
                    messages.append(try mail("event-\(step)", .map(update)))
                    model = state == "resolved" ? .resolved : .superseded
                default: XCTFail("Unreachable")
                }
                let real = try XCTUnwrap(inboxThreads(messages, preferences: [key: prefs]).first)
                XCTAssertEqual(real.state, model); XCTAssertEqual(real.archived, archived)
                XCTAssertEqual(real.visible(at: now, archivedView: false), !archived && (!snoozed || model == .resolved || model == .superseded))
                XCTAssertEqual(real.visible(at: now.addingTimeInterval(3601), archivedView: false), !archived)
                XCTAssertEqual(real.visible(at: now, archivedView: true), archived)
            }
        }
        let chat = try mail("chat", .string("unused"))
        let plain = MailItem(id: chat.id, message: chat.message, sender: sender, text: "Plain text stays chat.", receipt: "delivered")
        let other = try mail("other", card, "did:web:other.example.invalid")
        XCTAssertEqual(try inboxThreads([incoming, plain, other], preferences: [:]).count, 3)
        var update = try fixture("update").object()
        update["state"] = .string("followup")
        XCTAssertEqual(try inboxThreads([incoming, mail("followup", .map(update))], preferences: [:]).first?.state, .open)
    }
    func testProtectedPersistenceAcrossGeneratedEdits() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        let store = try ProtectedLocalStore(directory: directory)
        defer { try? FileManager.default.removeItem(at: directory) }
        for count in 0..<100 {
            var prefs = ThreadPreferences(); prefs.archived = count % 2 == 0; prefs.snoozedUntil = Date(timeIntervalSince1970: Double(count)); prefs.answer = try fixture("answer")
            let message = MailItem(id: "sample", message: .map(["messageId": .string("3m5abcde23456")]), sender: "did:web:sample.example.invalid", text: String(repeating: "Sample ", count: count), receipt: "delivered")
            let saved = Value.map(["message": message.wire, "prefs": prefs.wire])
            try store.write("inbox.json", bytes: saved.jsonData())
            let decoded = try Value.json(XCTUnwrap(store.read("inbox.json")))
            XCTAssertEqual(try MailItem(decoded.required("message")).text, message.text)
            XCTAssertEqual(try ThreadPreferences(decoded.required("prefs")).wire, prefs.wire)
            XCTAssertEqual(try directory.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup, true)
        }
    }
    func testCompleteFileProtectionOnDevice() throws {
        #if targetEnvironment(simulator)
        throw XCTSkip("Simulator filesystem does not expose iOS data-protection attributes; run on the phone")
        #else
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        let store = try ProtectedLocalStore(directory: directory)
        defer { try? FileManager.default.removeItem(at: directory) }
        try store.write("inbox.json", bytes: Data("sample".utf8))
        let attributes = try FileManager.default.attributesOfItem(atPath: directory.appendingPathComponent("inbox.json").path)
        XCTAssertEqual(attributes[.protectionKey] as? FileProtectionType, .complete)
        #endif
    }
    func testSnoozeAlwaysUsesFutureLocalCalendarTime() {
        var calendar = Calendar(identifier: .gregorian); calendar.timeZone = TimeZone(identifier: "America/Los_Angeles")!
        for day in 1...28 { for hour in 0...23 {
            let now = calendar.date(from: DateComponents(year: 2026, month: 3, day: day, hour: hour, minute: 30))!
            for choice in SnoozeChoice.allCases { XCTAssertGreaterThan(choice.date(from: now, calendar: calendar), now) }
            let tomorrow = SnoozeChoice.tomorrow.date(from: now, calendar: calendar)
            XCTAssertEqual(calendar.component(.hour, from: tomorrow), 9)
            XCTAssertEqual(calendar.dateComponents([.day], from: calendar.startOfDay(for: now), to: calendar.startOfDay(for: tomorrow)).day, 1)
        } }
    }
}
