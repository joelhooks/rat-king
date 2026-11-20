import XCTest
@testable import RatKing

final class TimelineProjectionTests: XCTestCase {
    func testProjectionOrdersMailAcrossPeersWithoutPromotingTrafficOrOtherDeskItems() {
        let first = AgentIdentity(did: "did:web:first.example.invalid", callsign: nil)
        let second = AgentIdentity(did: "did:web:second.example.invalid", callsign: nil)
        let older = entry("3m5abcde23456", kind: .desk(threadId: "action"))
        let newer = entry("3m5abcde23457", kind: .desk(threadId: "done"))
        let traffic = entry("3m5abcde23458", kind: .sealed, hasMail: false)
        let groups = [Conversation(agent: first, entries: [older, traffic]), Conversation(agent: second, entries: [newer])]
        for input in [groups, groups.reversed().map { $0 }] {
            let posts = TimelinePost.project(input, needingAnswer: ["action"])
            XCTAssertEqual(posts.map(\.id), [newer.id, older.id])
            XCTAssertEqual(posts.map(\.agent), [second, first])
            XCTAssertEqual(posts.filter(\.needsAnswer).map(\.id), [older.id])
        }
    }

    private func entry(_ id: String, kind: ConversationEntry.Kind, hasMail: Bool = true) -> ConversationEntry {
        ConversationEntry(id: id, messageId: id, outgoing: false, text: "Invented update", receipt: "delivered", kind: kind, mailId: hasMail ? id : nil)
    }
}
