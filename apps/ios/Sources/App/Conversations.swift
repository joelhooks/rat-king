import Foundation
import Observation

// One conversation per peer, projected from what the phone already stores:
// Mail (both directions), saved desk answers and memory-only Traffic rows.
// No server call, no extra file. A message seen in Mail and Traffic shows once.

// Fleet DIDs are did:web:<project>.<row>.<kind>.ratking-fleet.invalid; the
// callsign is the latest `label` the agent signed into a pi-ratking payload.
struct AgentIdentity: Identifiable, Hashable {
    let did: String; let name: String; let project: String?; var callsign: String?
    var id: String { did }
    init(did: String, callsign: String? = nil) {
        self.did = did; self.callsign = callsign
        let host = did.hasPrefix("did:web:") ? String(did.dropFirst(8)) : did, short = TrafficEntry.shortName(did)
        let labels = short.split(separator: ".").map(String.init)
        guard short != host, labels.count > 1 else { name = short; project = nil; return }
        let row = labels.dropLast()
        name = row.count > 1 ? row[0] + "/" + row.dropFirst().joined(separator: ".") : row[0]
        project = row.count > 1 ? row[0] : nil
    }
    var searchFields: [String] { [name, callsign ?? "", project ?? ""] }
}

// TIDs sort chronologically as strings; the leading 54 bits are microseconds.
func tidDate(_ tid: String) -> Date? {
    let alphabet = Array("234567abcdefghijklmnopqrstuvwxyz")
    guard tid.count == 13 else { return nil }
    var value: UInt64 = 0
    for character in tid { guard let index = alphabet.firstIndex(of: character) else { return nil }; value = value << 5 | UInt64(index) }
    return Date(timeIntervalSince1970: Double(value >> 10) / 1_000_000)
}

struct ConversationEntry: Identifiable, Equatable {
    enum Kind: Equatable { case message, desk(threadId: String), update, sealed }
    let id: String; let messageId: String; let outgoing: Bool
    let text: String; let receipt: String
    // The answered entry when it is in this conversation; depth counts the chain.
    var parentId: String?; var depth = 0
    let kind: Kind; let mailId: String?
    var label: String?
    var date: Date? { tidDate(messageId) }
}
struct Conversation: Identifiable, Equatable {
    var agent: AgentIdentity
    var entries: [ConversationEntry] = []
    var threadIds: [String] = []
    var projects: [String] = []
    var unread = 0; var needsAnswer = false; var archived = false
    var id: String { agent.did }
    var latest: ConversationEntry? { entries.last }
    var facts: ListFacts {
        ListFacts(unread: unread > 0, needsAnswer: needsAnswer, archived: archived, projects: projects, text: agent.searchFields + entries.map(\.text))
    }
}

func conversationList(phone: String?, messages: [MailItem], threads: [InboxThread], preferences: [String: ThreadPreferences] = [:], traffic: [TrafficEntry] = []) -> [Conversation] {
    var threadOf: [String: InboxThread] = [:]
    for thread in threads { for id in thread.mailIds { threadOf[id] = thread } }
    var raw: [String: [(entry: ConversationEntry, replyTo: String?, replyToId: String?)]] = [:]
    var seen = Set<String>()
    func add(_ peer: String, _ entry: ConversationEntry, replyTo: String? = nil, replyToId: String? = nil) {
        guard peer != phone, seen.insert(entry.id).inserted else { return }
        raw[peer, default: []].append((entry, replyTo, replyToId))
    }
    for mail in messages {
        let messageId = (try? mail.message.required("messageId").text) ?? String(mail.id.split(separator: "/").last ?? "")
        let replyToId = mail.replyTo.flatMap { ref -> String? in
            guard let sender = try? ref.required("senderDid").text, let tid = try? ref.required("messageId").text else { return nil }; return sender + "/" + tid
        }
        let outgoing = mail.outgoingTo != nil
        switch try? mail.record() {
        case let .item(_, card)?:
            add(mail.threadPeer, ConversationEntry(id: mail.id, messageId: messageId, outgoing: outgoing, text: card.title, receipt: mail.receipt, kind: .desk(threadId: threadOf[mail.id]?.id ?? ""), mailId: mail.id), replyToId: replyToId)
        case let .update(_, _, _, state, text)?:
            add(mail.threadPeer, ConversationEntry(id: mail.id, messageId: messageId, outgoing: outgoing, text: "UPDATE " + state + (text.map { ": " + $0 } ?? ""), receipt: mail.receipt, kind: .update, mailId: mail.id), replyToId: replyToId)
        case let .answer(value)?:
            add(mail.threadPeer, ConversationEntry(id: mail.id, messageId: messageId, outgoing: outgoing, text: (try? deskAnswerLine(value)) ?? "Reply", receipt: mail.receipt, kind: .message, mailId: mail.id), replyToId: replyToId)
        default:
            let parsed = MessageText(mail.text)
            add(mail.threadPeer, ConversationEntry(id: mail.id, messageId: messageId, outgoing: outgoing, text: parsed.text, receipt: mail.receipt, kind: .message, mailId: mail.id, label: parsed.label), replyTo: parsed.replyTo, replyToId: replyToId)
        }
    }
    // Desk answers are sealed and saved as preferences, not Mail items.
    for thread in threads {
        guard let prefs = preferences[thread.id], let ref = prefs.outgoingRef, let answer = prefs.answer,
              let sender = try? ref.required("senderDid").text, let tid = try? ref.required("messageId").text else { continue }
        add(thread.sender, ConversationEntry(id: sender + "/" + tid, messageId: tid, outgoing: true, text: (try? deskAnswerLine(answer)) ?? "Reply", receipt: "sent", kind: .message, mailId: nil),
            replyToId: thread.cardTid.map { thread.sender + "/" + $0 })
    }
    if let phone {
        for row in traffic {
            let peer = row.senderDid == phone ? row.recipientDid : row.recipientDid == phone ? row.senderDid : nil
            guard let peer else { continue }
            let parsed = row.message
            add(peer, ConversationEntry(id: row.senderDid + "/" + row.messageId, messageId: row.messageId, outgoing: row.senderDid == phone,
                text: parsed?.text ?? "sealed · \(row.ciphertextSize) B", receipt: row.state, kind: parsed == nil ? .sealed : .message, mailId: nil, label: parsed?.label), replyTo: parsed?.replyTo)
        }
    }
    var result: [Conversation] = []
    for (peer, items) in raw {
        // Chronological by TID; anything without a TID keeps arrival order at the end.
        let ordered = items.enumerated().sorted { a, b in
            switch (tidDate(a.element.entry.messageId) != nil, tidDate(b.element.entry.messageId) != nil) {
            case (true, true): return a.element.entry.messageId == b.element.entry.messageId ? a.offset < b.offset : a.element.entry.messageId < b.element.entry.messageId
            case (true, false): return true
            case (false, true): return false
            case (false, false): return a.offset < b.offset
            }
        }.map(\.element)
        let ids = Set(ordered.map(\.entry.id))
        var depth: [String: Int] = [:]
        var entries: [ConversationEntry] = []
        for item in ordered {
            var entry = item.entry
            let parent = item.replyToId.flatMap { ids.contains($0) ? $0 : nil }
                ?? item.replyTo.flatMap { tid in ordered.first { $0.entry.messageId == tid && $0.entry.id != entry.id }?.entry.id }
            entry.parentId = parent
            entry.depth = parent.map { (depth[$0] ?? 0) + 1 } ?? 0
            depth[entry.id] = entry.depth
            entries.append(entry)
        }
        let peerThreads = threads.filter { $0.sender == peer }
        var conversation = Conversation(agent: AgentIdentity(did: peer, callsign: entries.last { !$0.outgoing && $0.label != nil }?.label), entries: entries)
        conversation.threadIds = peerThreads.map(\.id)
        conversation.projects = Array(Set(([conversation.agent.project] + peerThreads.map { $0.project == "CHAT" ? nil : $0.project }).compactMap { $0 })).sorted()
        conversation.unread = messages.filter { $0.threadPeer == peer && $0.outgoingTo == nil && $0.receipt == "delivered" }.count
        conversation.needsAnswer = peerThreads.contains(where: threadNeedsAnswer)
        conversation.archived = !peerThreads.isEmpty && peerThreads.allSatisfy(\.archived)
        result.append(conversation)
    }
    return result.sorted { ($0.latest?.messageId ?? "", $0.id) > ($1.latest?.messageId ?? "", $1.id) }
}
func threadNeedsAnswer(_ thread: InboxThread) -> Bool { thread.state == .open && ["decision", "approval"].contains(thread.card?.kind ?? "") }

// Known peers plus everyone the phone has talked to; recently messaged first.
struct AgentDirectory: Equatable {
    var recent: [AgentIdentity] = []; var all: [AgentIdentity] = []
    init(phone: String?, known: [String], conversations: [Conversation], recentLimit: Int = 5) {
        let byDid = Dictionary(conversations.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let dids = Set(known).union(byDid.keys).subtracting([phone].compactMap { $0 })
        all = dids.map { byDid[$0]?.agent ?? AgentIdentity(did: $0) }.sorted { ($0.name, $0.did) < ($1.name, $1.did) }
        recent = conversations.compactMap { conversation -> (String, AgentIdentity)? in
            guard conversation.id != phone, let sent = conversation.entries.last(where: \.outgoing) else { return nil }; return (sent.messageId, conversation.agent)
        }.sorted { $0.0 > $1.0 }.prefix(recentLimit).map(\.1)
    }
    func matching(_ query: String) -> AgentDirectory {
        var copy = self
        copy.recent = recent.filter { searchMatches(query, $0.searchFields) }; copy.all = all.filter { searchMatches(query, $0.searchFields) }
        return copy
    }
}

// Filter and light search. Local only; nothing is indexed or written.
enum ListScope: String, CaseIterable, Identifiable { case all, unread, answer = "needs answer", archived; var id: String { rawValue } }
struct ListFacts: Equatable {
    var unread = false; var needsAnswer = false; var archived = false
    var projects: [String] = []; var text: [String] = []
}
struct ListFilter: Equatable {
    var scope = ListScope.all; var project: String?; var query = ""
    func admits(_ facts: ListFacts) -> Bool {
        let scoped: Bool
        switch scope {
        case .all: scoped = !facts.archived
        case .unread: scoped = !facts.archived && facts.unread
        case .answer: scoped = !facts.archived && facts.needsAnswer
        case .archived: scoped = facts.archived
        }
        return scoped && (project.map { facts.projects.contains($0) } ?? true) && searchMatches(query, facts.projects + facts.text)
    }
}
// Every whitespace-separated term must appear in some field, ignoring case and accents.
func searchMatches(_ query: String, _ fields: [String]) -> Bool {
    query.split(whereSeparator: \.isWhitespace).allSatisfy { term in
        fields.contains { $0.range(of: term, options: [.caseInsensitive, .diacriticInsensitive]) != nil }
    }
}
// Memory-only; each list keeps its filter across tab switches.
@MainActor @Observable final class ListFilters {
    var conversations = ListFilter(); var desk = ListFilter(); var traffic = ListFilter()
}
func threadFacts(_ thread: InboxThread, unread: Int, callsign: String?) -> ListFacts {
    let agent = AgentIdentity(did: thread.sender, callsign: callsign)
    return ListFacts(unread: unread > 0, needsAnswer: threadNeedsAnswer(thread), archived: thread.archived,
        projects: [thread.project == "CHAT" ? nil : thread.project, agent.project].compactMap { $0 },
        text: agent.searchFields + [thread.title, thread.card?.why ?? "", thread.card?.body ?? ""] + thread.lines)
}
func trafficFacts(_ entry: TrafficEntry, seen: Bool, archived: Bool) -> ListFacts {
    let sender = AgentIdentity(did: entry.senderDid, callsign: entry.message?.label), recipient = AgentIdentity(did: entry.recipientDid)
    var desk = false
    if let body = entry.body, let value = try? Value.json(Data(body.utf8)), case let .item(_, card)? = try? DeskRecord.decode(value) { desk = ["decision", "approval"].contains(card.kind) }
    return ListFacts(unread: !seen, needsAnswer: desk, archived: archived, projects: [sender.project, recipient.project].compactMap { $0 },
        text: sender.searchFields + recipient.searchFields + [entry.message?.text ?? ""])
}
// Latest signed callsign per sender, from Mail and Traffic.
func callsigns(messages: [MailItem], traffic: [TrafficEntry]) -> [String: String] {
    var result: [String: String] = [:]
    for row in traffic.reversed() { if let label = row.message?.label { result[row.senderDid] = label } }
    for mail in messages where mail.outgoingTo == nil { if let label = MessageText(mail.text).label { result[mail.sender] = label } }
    return result
}
