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
    func testOneMessageRowLatestStatusAndCompactDetailAgainstGeneratedJournalCommands() throws {
        var seed: UInt64 = 563
        for _ in 0..<100 {
            var journal = TrafficJournal(), model: [TrafficEntry] = []
            var selected: TrafficEntry?
            for seq in 1...80 {
                seed = seed &* 6364136223846793005 &+ 1
                var wire = try trafficWire(Int64(seq)).object()
                let messageId = (seed >> 32) % 3 == 0 ? "3m5abcde23456" : "3m5abcde23457"
                wire["messageId"] = .string(messageId)
                wire["senderDid"] = .string("did:web:sender-\((seed >> 38) % 2).example.invalid")
                wire["recipientDid"] = .string("did:web:recipient-\((seed >> 42) % 2).example.invalid")
                if seq % 5 == 1 { wire["body"] = .string("Synthetic body \(seq)") }
                wire["time"] = .string("2026-01-01T12:00:\(String(format: "%02d", 80 - seq > 59 ? 59 : 80 - seq)).000Z")
                let entry = try TrafficEntry(.map(wire))
                try journal.append(trafficPage([.map(wire)], cursor: Int64(seq))); model.append(entry)
                if selected == nil || (seed >> 40) % 11 == 0 { selected = entry }
                let anchor = try XCTUnwrap(selected)
                let detail = TrafficDetail(selected: anchor, entries: journal.entries)
                let expected = model.filter { $0.messageKey == anchor.messageKey }
                XCTAssertEqual(detail.selected, anchor)
                XCTAssertEqual(detail.events, expected) // arrival sequence, not skewed clocks
                for state in TrafficDetail.stages {
                    XCTAssertEqual(detail.observations(for: state), expected.filter { $0.state == state })
                }
                XCTAssertEqual(detail.otherEvents, expected.filter { !TrafficDetail.stages.contains($0.state) })
                let keys = model.map(\.messageKey).reduce(into: [String]()) { keys, key in if !keys.contains(key) { keys.append(key) } }.reversed()
                XCTAssertEqual(journal.messages.map(\.messageKey), Array(keys))
                for row in journal.messages {
                    let latest = try XCTUnwrap(model.last(where: { $0.messageKey == row.messageKey }))
                    XCTAssertEqual(row.state, latest.state); XCTAssertEqual(row.seq, latest.seq)
                    XCTAssertEqual(row.recipientSeq, latest.recipientSeq)
                    XCTAssertEqual(row.body, model.filter { $0.messageKey == row.messageKey }.compactMap(\.body).last)
                }
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
    @MainActor func testLoadThenShowBuffersLiveArrivalsAndReconnectHidesRows() async throws {
        let paged = expectation(description: "catch-up blocked after first page")
        let live = expectation(description: "initial list complete")
        let new = expectation(description: "live arrival processed")
        let service = LoadThenShowService(paged: paged, live: live, new: new)
        let store = TrafficStore(transport: TrafficTransport(open: {
            TrafficConnection(authenticate: {}, notice: { try await service.notice() }, close: {})
        }, list: { try await service.list($0) }))
        store.start(); await fulfillment(of: [paged], timeout: 5)
        XCTAssertTrue(store.presentation.loading); XCTAssertGreaterThan(store.presentation.progress, 0)
        XCTAssertTrue(store.rows.isEmpty) // production list projects exactly these rows
        await service.finishSnapshot(); await fulfillment(of: [live], timeout: 5)
        XCTAssertFalse(store.presentation.loading); XCTAssertEqual(store.rows.count, 2)
        let before = store.rows.map(\.messageKey)
        await service.arrive(); await fulfillment(of: [new], timeout: 5)
        XCTAssertEqual(store.rows.map(\.messageKey), before); XCTAssertEqual(store.presentation.pending.count, 1)
        store.revealNew(); XCTAssertEqual(store.rows.count, 3); XCTAssertTrue(store.presentation.pending.isEmpty)
        store.refresh(); XCTAssertTrue(store.presentation.loading); XCTAssertTrue(store.rows.isEmpty)
        store.stop(); await service.close()
        // The desk uses the same gate with individual mail IDs, including a
        // follow-up in an existing thread. Exercise arbitrary loading/update/reveal commands.
        var seed: UInt64 = 53
        for _ in 0..<100 {
            var gate = InboxPresentation<Int>(), complete = false, visible: [Int] = []
            var ids: [Int] = []
            for id in 0..<100 {
                seed = seed &* 6364136223846793005 &+ 1; ids.insert(id, at: 0)
                if seed % 7 == 0 { gate.begin(); complete = false; visible = [] }
                gate.loaded(ids.count); gate.update(ids)
                XCTAssertEqual(gate.visible, visible)
                if !complete { XCTAssertTrue(gate.visible.isEmpty) }
                if seed % 3 == 0 {
                    gate.reveal(ids); complete = true; visible = ids
                    XCTAssertTrue(gate.pending.isEmpty)
                } else if complete { XCTAssertEqual(gate.pending, ids.filter { !visible.contains($0) }) }
            }
        }
    }
    func testCallSignLeadsTheSenderLineAndAMissingOneFallsBackToTheName() throws {
        var wire = try trafficWire(1).object()
        wire["body"] = .string(#"{"body":"hello","from":"nicodemus","label":"🔮 Nicodemus · Rat King desk"}"#)
        let labelled = try TrafficEntry(.map(wire))
        XCTAssertEqual(labelled.message?.label, "🔮 Nicodemus · Rat King desk"); XCTAssertEqual(labelled.message?.text, "hello")
        wire["body"] = .string(#"{"body":"hello","from":"nicodemus"}"#)
        let bare = try TrafficEntry(.map(wire))
        XCTAssertNil(bare.message?.label); XCTAssertEqual(bare.message?.label ?? bare.route, "sample-sender.example.invalid → sample-recipient.example.invalid")
        XCTAssertNil(try TrafficEntry(trafficWire(1)).message)
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

private actor LoadThenShowService {
    let paged: XCTestExpectation; let live: XCTestExpectation; let new: XCTestExpectation
    private var reads = 0
    private var page: CheckedContinuation<Void, Never>?
    private var noticeWait: CheckedContinuation<Int64, any Error>?
    init(paged: XCTestExpectation, live: XCTestExpectation, new: XCTestExpectation) { self.paged = paged; self.live = live; self.new = new }
    func notice() async throws -> Int64 {
        reads += 1
        if reads == 1 { return 101 }
        if reads == 2 { live.fulfill() } else if reads == 3 { new.fulfill() }
        return try await withCheckedThrowingContinuation { noticeWait = $0 }
    }
    func list(_ cursor: Int64) async throws -> TrafficPage {
        if cursor == 0 { return try trafficPage((1...100).map { trafficWire(Int64($0)) }, cursor: 100) }
        if cursor == 100 {
            await withCheckedContinuation { page = $0; paged.fulfill() }
            var wire = try trafficWire(101).object(); wire["messageId"] = .string("3m5abcde23457")
            return try trafficPage([.map(wire)], cursor: 101)
        }
        var wire = try trafficWire(102).object(); wire["messageId"] = .string("3m5abcde2345a")
        return try trafficPage([.map(wire)], cursor: 102)
    }
    func finishSnapshot() { let value = page; page = nil; value?.resume() }
    func arrive() { let value = noticeWait; noticeWait = nil; value?.resume(returning: 102) }
    func close() { let value = noticeWait; noticeWait = nil; value?.resume(throwing: CancellationError()) }
}
