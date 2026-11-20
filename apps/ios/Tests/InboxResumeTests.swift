import XCTest
@testable import RatKing

final class InboxResumeTests: XCTestCase {
    @MainActor func testGeneratedRestartAppendAndResetKeepsCursorAndProjectionTogether() async throws {
        var seed: UInt64 = 151
        for _ in 0..<40 {
            var high: Int64 = 500
            var file = try inboxFile(messages: [], copies: [], preferences: [:], cursor: InboxCursor()).jsonData()
            var committed: Set<Int64> = []
            for _ in 0..<30 {
                seed = seed &* 6364136223846793005 &+ 1
                let command = (seed >> 32) % 5
                if command == 0 { high += Int64((seed >> 40) % 170) }
                if command == 1 { high = Int64((seed >> 40) % UInt64(high + 1)) }
                let saved = try InboxCursor(Value.json(file))
                var reads: [InboxRead] = []
                let previous = committed
                let shouldFail = command == 2
                do {
                    try await syncInbox(from: saved, list: { read in
                        reads.append(read)
                        if case let .since(after) = read, after > high { throw XRPCError(code: "InvalidCursor", status: 400) }
                        return try mockPage(read, high: high)
                    }, commit: { _, events, cursor in
                        if shouldFail { throw CocoaError(.fileWriteUnknown) }
                        let seqs = try events.map { try $0.required("seq").number }
                        let received = seqs.map { MailItem(id: String($0), message: .int($0), sender: "sender", text: "body", receipt: "delivered") }
                        let old = try Value.json(file).required("messages").list().map(MailItem.init)
                        let known = Set(old.map(\.id))
                        let new = old + received.filter { !known.contains($0.id) }
                        file = try inboxFile(messages: new, copies: [], preferences: [:], cursor: cursor).jsonData()
                        committed.formUnion(seqs)
                    })
                    XCTAssertFalse(shouldFail)
                    let actual = try InboxCursor(Value.json(file))
                    XCTAssertEqual(actual.through, high)
                    if let prior = saved.through, prior <= high {
                        XCTAssertEqual(reads.first, .since(prior))
                        XCTAssertTrue(reads.allSatisfy(\.isForward))
                        if prior < high { XCTAssertTrue(Set((prior + 1)...high).isSubset(of: committed)) }
                        XCTAssertEqual(actual.before, saved.before)
                    } else {
                        XCTAssertEqual(reads.count, saved.through == nil ? 1 : 2)
                        XCTAssertEqual(reads.last, .newest)
                        XCTAssertEqual(actual.before, high > 50 ? high - 49 : nil)
                        if high > 0 { XCTAssertTrue(Set(max(1, high - 49)...high).isSubset(of: committed)) }
                    }
                } catch {
                    XCTAssertTrue(shouldFail)
                    XCTAssertEqual(try InboxCursor(Value.json(file)), saved)
                    XCTAssertEqual(committed, previous)
                }
                let reread = try Value.json(file).required("messages").list().map(MailItem.init)
                XCTAssertEqual(Set(reread.compactMap { Int64($0.id) }), committed)
                XCTAssertEqual(reread.count, committed.count)
            }
        }
        XCTAssertEqual(try InboxCursor(.map(["through": .int(42)])), InboxCursor(through: 42))
        XCTAssertEqual(try InboxCursor(.map(["through": .int(0)])), InboxCursor())
    }

    func testGeneratedOlderPagesNeverOverlapAndCoverTheBacklog() throws {
        for high in stride(from: Int64(0), through: 525, by: 3) {
            var request = InboxRead.newest, seen: [Int64] = []
            while true {
                let page = try mockPage(request, high: high)
                seen += try page.events.map { try $0.required("seq").number }
                guard let before = page.next else { break }
                request = .older(before)
            }
            XCTAssertEqual(seen, high > 0 ? Array((1...high).reversed()) : [])
        }
    }

    func testSparseTapTargetsAndBackfillKeepAdmissionOrder() {
        let row: (Int64) -> MailItem = { seq in
            MailItem(id: String(seq), message: .int(seq), sender: "sender", text: "body", receipt: "delivered", admissionSeq: seq)
        }
        for tap in Int64(1)...100 {
            var rows = (151...200).map(row)
            let batches = [[tap], Array(Int64(101)...150), Array(Int64(51)...100), Array(Int64(1)...50)]
            var known = Set(rows.map(\.id))
            for batch in batches {
                rows += batch.map(row).filter { known.insert($0.id).inserted }
                mergeInboxHistory(&rows, ids: Set(batch.map(String.init)))
                XCTAssertEqual(rows.compactMap(\.admissionSeq), known.compactMap(Int64.init).sorted())
            }
        }
    }

    @MainActor func testNotificationReferenceSelectsExactVerifiedThreadAcrossSenderCollision() throws {
        let id = "3m5abcde23456"
        let a = "did:web:alpha.example.invalid", b = "did:web:b.example.invalid"
        let rows = [(a, Int64(7)), (b, Int64(81))].map { sender, seq in
            let ref: Value = .map(["senderDid": .string(sender), "messageId": .string(id)])
            return MailItem(id: sender + "/" + id, message: ref, sender: sender, text: "body", receipt: "delivered", admissionSeq: seq)
        }
        let store = InboxStore(preview: "did:web:phone.example.invalid", peers: [], messages: rows)
        let tap = try XCTUnwrap(PushTap(["messageId": id, "admissionSeq": 81]))
        XCTAssertEqual(store.route(for: tap), .conversation(b, focus: false))
        XCTAssertNil(store.route(for: try XCTUnwrap(PushTap(["messageId": id, "admissionSeq": 82]))))
        XCTAssertNil(PushTap(["messageId": "not-a-tid", "admissionSeq": 81]))
    }

    func testGeneratedNonAdvancingAndMismatchedCursorsAreRejected() {
        for after in Int64(1)...100 {
            let seq = after + 1
            let event = Value.map(["seq": .int(seq)])
            let badCursors: [[String: Value]] = [
                ["nextAfterSeq": .int(after)], ["nextAfterSeq": .int(seq + 1)], ["nextBeforeSeq": .int(seq)]
            ]
            for cursor in badCursors {
                let wire = cursor.merging(["latestSeq": .int(seq + 2), "events": .array([event])]) { $1 }
                XCTAssertThrowsError(try InboxPage(.map(wire), request: .since(after)))
            }
            XCTAssertThrowsError(try InboxPage(.map(["latestSeq": .int(seq), "events": .array([event, event])]), request: .since(after)))
        }
    }

    func testCachedRowsStayVisibleWhileSyncingAndBackfillDoesNotRevealLiveMail() {
        var seed: UInt64 = 211
        for _ in 0..<100 {
            seed = seed &* 6364136223846793005 &+ 1
            var ids = Array((0..<Int((seed >> 33) % 6)).map { $0 + 100 }.reversed())
            var gate = InboxPresentation<Int>(); gate.resume(ids)
            var visible = ids, loading = ids.isEmpty
            for i in 1...60 {
                seed = seed &* 6364136223846793005 &+ 1
                switch (seed >> 32) % 5 {
                case 0: ids.insert(i, at: 0); gate.loaded(i); gate.update(ids)
                case 1: gate.settle(ids); if loading { visible = ids; loading = false }
                case 2: gate.resume(ids); if visible.isEmpty { visible = ids; loading = ids.isEmpty }
                case 3 where !loading: ids.append(-i); gate.addHistory([-i], in: ids); visible.append(-i)
                default: gate.reveal(ids); visible = ids; loading = false
                }
                XCTAssertEqual(gate.visible, visible); XCTAssertEqual(gate.loading, loading)
                if !loading { XCTAssertEqual(gate.pending, ids.filter { !visible.contains($0) }) }
            }
        }
    }
}

private func mockPage(_ request: InboxRead, high: Int64) throws -> InboxPage {
    let seqs: [Int64]
    var fields: [String: Value] = ["latestSeq": .int(high)]
    switch request {
    case let .since(lower):
        let end = min(high, lower + 50)
        seqs = end > lower ? Array((lower + 1)...end) : []
        if end < high { fields["nextAfterSeq"] = .int(end) }
    case .newest, .older:
        let upper: Int64
        if case let .older(before) = request { upper = min(high, before - 1) } else { upper = high }
        seqs = upper > 0 ? Array((max(1, upper - 49)...upper).reversed()) : []
        if upper > 50 { fields["nextBeforeSeq"] = .int(upper - 49) }
    }
    fields["events"] = .array(request.isForward ? seqs.map { .map(["seq": .int($0)]) } : [])
    if !request.isForward {
        fields["messages"] = .array(seqs.map { .map(["admissionSeq": .int($0), "envelope": .map([:]), "receipt": .map([:])]) })
    }
    return try InboxPage(.map(fields), request: request)
}
