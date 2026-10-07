import XCTest
@testable import RatKing

private func trafficWire(_ seq: Int64) -> Value {
    .map(["seq": .int(seq), "recipientSeq": .int(seq), "time": .string("2026-01-01T12:00:00.000Z"),
        "senderDid": .string("did:web:sample-sender.example.invalid"), "recipientDid": .string("did:web:sample-recipient.example.invalid"),
        "messageId": .string("3m5abcde23456"), "ciphertextSize": .int(seq * 7), "state": .string(["accepted", "queued", "delivered", "acked", "expired", "failed"][Int(abs(seq % 6))]),
        "unknownFutureField": .string("Invented content that must not enter the metadata projection")])
}
private func trafficPage(_ entries: [Value], cursor: Int64) throws -> TrafficPage { try TrafficPage(.map(["events": .array(entries), "cursor": .string(String(cursor))])) }

final class TrafficTests: XCTestCase {
    func testJournalAgainstGeneratedAppendReplayAndMalformedPageCommands() throws {
        var seed: UInt64 = 901
        for _ in 0..<100 {
            var journal = TrafficJournal(), model: [Int64] = []
            for _ in 0..<100 {
                seed = seed &* 6364136223846793005 &+ 1
                let count = Int((seed >> 32) % 8), cursor = model.last ?? 0
                let sequences = (0..<count).map { cursor + Int64($0) + 1 }
                let values = sequences.map(trafficWire)
                let valid = try trafficPage(values, cursor: sequences.last ?? cursor)
                if (seed >> 40) % 3 == 0 {
                    let broken = try trafficPage(values, cursor: (sequences.last ?? cursor) + 1)
                    XCTAssertThrowsError(try journal.append(broken))
                } else {
                    try journal.append(valid); model.append(contentsOf: sequences)
                    if !values.isEmpty { XCTAssertThrowsError(try journal.append(valid)) }
                }
                XCTAssertEqual(journal.entries.map(\.seq), model); XCTAssertEqual(journal.cursor, model.last ?? 0)
                XCTAssertEqual(journal.entries.reversed().map(\.seq), model.reversed().map { $0 })
                for entry in journal.entries.suffix(8) {
                    XCTAssertFalse(String(describing: entry).contains("Invented content"))
                    XCTAssertEqual(entry.ciphertextSize, entry.seq * 7)
                }
            }
        }
        for seq in [Int64(0), -1, 9_007_199_254_740_992] { XCTAssertThrowsError(try TrafficEntry(trafficWire(seq))) }
        for field in ["seq", "recipientSeq", "time", "senderDid", "recipientDid", "messageId", "ciphertextSize", "state"] {
            var fields = try trafficWire(1).object(); fields.removeValue(forKey: field); XCTAssertThrowsError(try TrafficEntry(.map(fields)))
        }
        for cursor in ["-1", "01", "not-a-cursor", "9007199254740992"] {
            XCTAssertThrowsError(try TrafficPage(.map(["events": .array([]), "cursor": .string(cursor)])))
        }
        for index in 0..<100 {
            let name = "sample-\(index)"
            XCTAssertEqual(TrafficEntry.shortName("did:web:" + name + ".ratking-fleet.invalid"), name)
            XCTAssertEqual(TrafficEntry.shortName("did:web:" + name + ".example.invalid"), name + ".example.invalid")
        }
    }
    func testDetailProjectionAgainstGeneratedJournalCommands() throws {
        var seed: UInt64 = 563
        for _ in 0..<100 {
            var journal = TrafficJournal(), model: [TrafficEntry] = []
            var selected: TrafficEntry?
            for seq in 1...80 {
                seed = seed &* 6364136223846793005 &+ 1
                var wire = try trafficWire(Int64(seq)).object()
                let messageId = (seed >> 32) % 3 == 0 ? "3m5abcde23456" : "3m5abcde23457"
                wire["messageId"] = .string(messageId)
                wire["time"] = .string("2026-01-01T12:00:\(String(format: "%02d", 80 - seq > 59 ? 59 : 80 - seq)).000Z")
                let entry = try TrafficEntry(.map(wire))
                try journal.append(trafficPage([.map(wire)], cursor: Int64(seq))); model.append(entry)
                if selected == nil || (seed >> 40) % 11 == 0 { selected = entry }
                let anchor = try XCTUnwrap(selected)
                let detail = TrafficDetail(selected: anchor, entries: journal.entries)
                let expected = model.filter { $0.messageId == anchor.messageId }
                XCTAssertEqual(detail.selected, anchor)
                XCTAssertEqual(detail.events, expected) // arrival sequence, not skewed clocks
                for state in TrafficDetail.stages {
                    XCTAssertEqual(detail.observations(for: state), expected.filter { $0.state == state })
                }
                XCTAssertEqual(detail.otherEvents, expected.filter { !TrafficDetail.stages.contains($0.state) })
                XCTAssertEqual(journal.entries, model) // display never mutates the source
            }
        }
    }
    @MainActor func testRealLifecycleCommandsCatchUpReconnectAndRejectStoppedTaskResults() async throws {
        let reached = expectation(description: "second connection live and waiting for notices")
        let service = TrafficModelService(reached: reached)
        let transport = TrafficTransport(open: {
            let id = UUID().uuidString
            return TrafficConnection(authenticate: { await service.auth(id) }, notice: { try await service.notice(id) }, close: { Task { await service.close(id) } })
        }, list: { cursor in try await service.list(cursor) })
        let store = TrafficStore(transport: transport, wait: { _ in try Task.checkCancellation() })
        store.start(); await fulfillment(of: [reached], timeout: 5)
        XCTAssertEqual(store.state, .live); XCTAssertEqual(store.journal.cursor, 207)
        XCTAssertEqual(store.journal.entries.map(\.seq), Array(1...207).map(Int64.init))
        let trace = await service.trace
        XCTAssertEqual(trace.prefix(8), ["auth:1", "ready:1", "list:0", "list:100", "rollover:1", "auth:2", "ready:2", "list:105"])
        XCTAssertTrue(trace.contains("list:205"))
        store.stop(); XCTAssertEqual(store.state, .paused)
        // The old socket deliberately ignores cancellation and emits a late notice.
        await service.lateNotice(); await Task.yield()
        XCTAssertEqual(store.journal.cursor, 207); XCTAssertEqual(store.state, .paused)
        let resumed = expectation(description: "foreground resume retains cursor")
        await service.resumeExpectation(resumed)
        store.start(); await fulfillment(of: [resumed], timeout: 5)
        XCTAssertEqual(store.journal.cursor, 207); XCTAssertEqual(store.journal.entries.count, 207)
        let resumedTrace = await service.trace; XCTAssertTrue(resumedTrace.contains("list:207"))
        store.stop(); await service.lateNotice()
    }
}
private actor TrafficModelService {
    var trace: [String] = []
    private var ids: [String: Int] = [:]; private var reads: [String: Int] = [:]
    private var pending: CheckedContinuation<Int64, any Error>?
    private var reached: XCTestExpectation
    init(reached: XCTestExpectation) { self.reached = reached }
    func auth(_ id: String) { ids[id] = ids.count + 1; trace.append("auth:\(ids[id]!)") }
    func notice(_ id: String) async throws -> Int64 {
        let number = ids[id]!, count = reads[id] ?? 0; reads[id] = count + 1
        if count == 0 { trace.append("ready:\(number)"); return number == 1 ? 105 : 207 }
        if number == 1 { trace.append("rollover:1"); throw ProtocolError.invalid("Synthetic socket rollover") }
        reached.fulfill()
        return try await withCheckedThrowingContinuation { pending = $0 }
    }
    func list(_ cursor: Int64) throws -> TrafficPage {
        trace.append("list:\(cursor)")
        let maxSeq: Int64 = ids.count == 1 ? 105 : 207
        let end = min(maxSeq, cursor + 100)
        let values = end > cursor ? ((cursor + 1)...end).map(trafficWire) : []
        return try trafficPage(values, cursor: end)
    }
    func close(_ id: String) { /* Keep the synthetic old receive pending to test fencing. */ }
    func lateNotice() { let old = pending; pending = nil; old?.resume(returning: 208) }
    func resumeExpectation(_ expectation: XCTestExpectation) { reached = expectation }
}
