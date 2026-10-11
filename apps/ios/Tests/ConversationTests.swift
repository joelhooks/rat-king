import XCTest
@testable import RatKing

final class ConversationTests: XCTestCase {
    private let phone = "did:web:phone.example.invalid"
    private let peers = ["alpha", "beta", "gamma"].map { "did:web:sample-project.\($0).pi.ratking-fleet.invalid" }
    private func tid(_ n: Int) -> String {
        let alphabet = Array("234567abcdefghijklmnopqrstuvwxyz")
        var value = UInt64(1_800_000_000_000_000 + n * 1000) << 10, result = ""
        for _ in 0..<13 { result.insert(alphabet[Int(value & 31)], at: result.startIndex); value >>= 5 }
        return result
    }
    private func card() throws -> String {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "desk-item", withExtension: "json", subdirectory: "fixtures"))
        return String(decoding: try Data(contentsOf: url), as: UTF8.self)
    }
    private func traffic(sender: String, recipient: String, messageId: String, seq: Int, body: String?) throws -> TrafficEntry {
        var fields: [String: Value] = ["seq": .int(Int64(seq)), "recipientSeq": .int(Int64(seq)), "time": .string("2026-01-01T12:00:00.000Z"), "senderDid": .string(sender),
            "recipientDid": .string(recipient), "messageId": .string(messageId), "ciphertextSize": .int(64), "state": .string("delivered")]
        if let body { fields["body"] = .string(body) }
        return try TrafficEntry(.map(fields))
    }

    // Generated mixed traffic: arrival order is shuffled, each message may answer an
    // earlier one in any conversation, and some also appear in the Traffic journal.
    func testGroupsMixedSentAndReceivedIntoOrderedNestedConversations() throws {
        let desk = try card()
        var seed: UInt64 = 2026
        func next(_ bound: Int) -> Int { seed = seed &* 6364136223846793005 &+ 1442695040888963407; return Int((seed >> 33) % UInt64(bound)) }
        for _ in 0..<100 {
            struct Sent { let peer: String; let id: String; let tid: String; let outgoing: Bool; let parent: String? }
            var model: [Sent] = [], mail: [MailItem] = [], rows: [TrafficEntry] = []
            for n in 0..<(5 + next(30)) {
                let peer = peers[next(peers.count)], outgoing = next(2) == 0, messageId = tid(n)
                let sender = outgoing ? phone : peer, id = sender + "/" + messageId
                let answered = model.isEmpty || next(3) == 0 ? nil : model[next(model.count)]
                let ref: Value? = answered.map { .map(["senderDid": .string(($0.outgoing ? phone : $0.peer)), "messageId": .string($0.tid)]) }
                model.append(Sent(peer: peer, id: id, tid: messageId, outgoing: outgoing, parent: answered?.peer == peer ? answered?.id : nil))
                switch next(4) {
                case 0 where !outgoing && answered == nil:
                    mail.append(MailItem(id: id, message: .map(["senderDid": .string(sender), "messageId": .string(messageId)]), sender: sender, text: desk, receipt: "delivered"))
                case 1 where !outgoing:
                    // Seen only by the observer: the payload carries the answered ID.
                    let replyTo = answered.map { #","replyTo":"\#($0.tid)""# } ?? ""
                    rows.append(try traffic(sender: sender, recipient: phone, messageId: messageId, seq: n + 1, body: #"{"body":"m\#(n)","from":"sample-project/x","label":"L\#(n)"\#(replyTo)}"#))
                default:
                    mail.append(MailItem(id: id, message: .map(["senderDid": .string(sender), "messageId": .string(messageId)]), sender: sender, text: "m\(n)", receipt: outgoing ? "accepted" : "delivered", replyTo: ref, outgoingTo: outgoing ? peer : nil))
                    if next(2) == 0 { rows.append(try traffic(sender: sender, recipient: outgoing ? peer : phone, messageId: messageId, seq: n + 1, body: nil)) }
                }
            }
            // Agent-to-agent observer rows are not the phone's conversations.
            rows.append(try traffic(sender: peers[0], recipient: peers[1], messageId: tid(999), seq: 999, body: "elsewhere"))
            var shuffled = mail
            for i in shuffled.indices.reversed() { shuffled.swapAt(i, next(i + 1)) }
            let threads = try inboxThreads(shuffled, preferences: [:])
            let real = conversationList(phone: phone, messages: shuffled, threads: threads, traffic: rows.reversed())
            XCTAssertEqual(Set(real.map(\.id)), Set(model.map(\.peer)))
            for conversation in real {
                let expected = model.filter { $0.peer == conversation.id }
                var depth: [String: Int] = [:]
                for sent in expected { depth[sent.id] = sent.parent.map { (depth[$0] ?? 0) + 1 } ?? 0 }
                XCTAssertEqual(conversation.entries.map(\.id), expected.map(\.id))
                XCTAssertEqual(conversation.entries.map(\.outgoing), expected.map(\.outgoing))
                XCTAssertEqual(conversation.entries.map(\.parentId), expected.map(\.parent))
                XCTAssertEqual(conversation.entries.map(\.depth), expected.map { depth[$0.id] ?? -1 })
                for entry in conversation.entries {
                    guard case let .desk(threadId) = entry.kind else { continue }
                    XCTAssertTrue(threads.contains { $0.id == threadId && $0.mailIds.contains(entry.id) })
                }
            }
        }
    }

    // Model: scope table, then project membership, then every search term in some field.
    func testFilterAndSearchPredicatesAcrossGeneratedFacts() throws {
        var seed: UInt64 = 404
        func next(_ bound: Int) -> Int { seed = seed &* 6364136223846793005 &+ 1442695040888963407; return Int((seed >> 33) % UInt64(bound)) }
        let words = ["Désk", "alpha", "Rat", "king", "ship", "wörker", "boss"], projects = ["sample-project", "other-project"]
        func fold(_ text: String) -> String { text.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil) }
        for _ in 0..<2000 {
            let facts = ListFacts(unread: next(2) == 0, needsAnswer: next(2) == 0, archived: next(2) == 0,
                projects: projects.filter { _ in next(2) == 0 }, text: (0..<next(4)).map { _ in words[next(words.count)] + " " + words[next(words.count)] })
            let scope = ListScope.allCases[next(ListScope.allCases.count)]
            let project = next(3) == 0 ? nil : projects[next(projects.count)]
            let terms = (0..<next(3)).map { _ in String(words[next(words.count)].prefix(2 + next(3))) }
            let query = terms.map { next(2) == 0 ? $0.uppercased() : $0 }.joined(separator: "  ")
            let scoped = switch scope {
            case .all: !facts.archived
            case .unread: !facts.archived && facts.unread
            case .answer: !facts.archived && facts.needsAnswer
            case .archived: facts.archived
            }
            let fields = (facts.projects + facts.text).map(fold)
            let expected = scoped && (project == nil || facts.projects.contains(project!)) && terms.allSatisfy { term in fields.contains { $0.contains(fold(term)) } }
            XCTAssertEqual(ListFilter(scope: scope, project: project, query: query).admits(facts), expected, "\(facts) \(scope) \(String(describing: project)) \(query)")
        }
        // Search reaches agent name, callsign, project and message text of a real conversation.
        let alpha = "did:web:sample-project.alpha.pi.ratking-fleet.invalid"
        let mail = MailItem(id: alpha + "/" + tid(1), message: .map(["senderDid": .string(alpha), "messageId": .string(tid(1))]), sender: alpha,
            text: #"{"body":"Ship the build","from":"sample-project/alpha","label":"Sample Callsign"}"#, receipt: "delivered")
        let conversation = try XCTUnwrap(conversationList(phone: phone, messages: [mail], threads: inboxThreads([mail], preferences: [:])).first)
        for query in ["sample-project/alpha", "callsign", "SAMPLE-PROJECT", "ship build"] { XCTAssertTrue(ListFilter(query: query).admits(conversation.facts), query) }
        XCTAssertFalse(ListFilter(query: "absent").admits(conversation.facts))
        XCTAssertTrue(ListFilter(scope: .unread, project: "sample-project").admits(conversation.facts))
    }
}
