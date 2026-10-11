import Foundation

// Thread lifecycle is a native switch projection, like the foreground mailbox.
// Snooze and archive change visibility, never the desk's authority.
enum ThreadState: String { case open, sent, resolved, superseded }
enum ThreadEvent { case answered, resolved, superseded, followup }
func threadState(_ state: ThreadState, _ event: ThreadEvent) -> ThreadState {
    switch (state, event) {
    case (_, .resolved): return .resolved
    case (_, .superseded): return .superseded
    case (.open, .answered): return .sent
    default: return state
    }
}
struct InboxThread: Identifiable {
    let id: String; let sender: String; let project: String; let itemId: String?
    var mailIds: [String] = []; var card: DeskCard?; var cardTid: String?
    var state: ThreadState = .open; var archived = false; var snoozedUntil: Date?
    var lines: [String] = []
    var latestSummary = ""
    var title: String { card?.title ?? sender }
    var summary: String { latestSummary.isEmpty ? title : title + " / " + latestSummary }
    static func firstLine(_ text: String) -> String { String(text.split(whereSeparator: \.isNewline).first ?? "").trimmingCharacters(in: .whitespaces) }
    func visible(at date: Date, archivedView: Bool) -> Bool { archivedView ? archived : !archived && (snoozedUntil.map { $0 <= date } ?? true) }
}
func canArchiveThread(_ thread: InboxThread, connection: ConnectionState) -> Bool { !thread.archived && connection == .live }
struct ThreadPreferences {
    var state: ThreadState = .open; var archived = false; var snoozedUntil: Date?
    var answer: Value?
    var outgoingRef: Value?
    var wire: Value {
        var fields: [String: Value] = ["state": .string(state.rawValue), "archived": .bool(archived)]
        if let snoozedUntil { fields["snoozedUntil"] = .int(Int64(snoozedUntil.timeIntervalSince1970)) }
        if let answer { fields["answer"] = answer }
        if let outgoingRef { fields["outgoingRef"] = outgoingRef }
        return .map(fields)
    }
    init() {}
    mutating func received() { archived = false; snoozedUntil = nil }
    init(_ value: Value) throws {
        guard let state = ThreadState(rawValue: try value.required("state").text), case let .bool(archived) = try value.required("archived") else { throw ProtocolError.invalid("Invalid thread preferences") }
        self.state = state; self.archived = archived
        if let saved = value["answer"] {
            guard case .answer = try DeskRecord.decode(saved) else { throw ProtocolError.invalid("Invalid saved desk answer") }; answer = saved
        }
        if let ref = value["outgoingRef"] { _ = try ref.required("senderDid").text; _ = try ref.required("messageId").text; outgoingRef = ref }
        if let time = value["snoozedUntil"] { snoozedUntil = Date(timeIntervalSince1970: Double(try time.number)) }
    }
}
func inboxThreadKey(sender: String, project: String, itemId: String?) throws -> String {
    String(decoding: try Value.array([.string(sender), .string(project), itemId.map(Value.string) ?? .null]).jsonData(), as: UTF8.self)
}
func inboxThreadAddress(_ mail: MailItem, messages: [MailItem] = [], preferences: [String: ThreadPreferences] = [:]) throws -> (project: String, itemId: String?) {
    func resolve(_ candidate: MailItem, seen: Set<String>) throws -> (project: String, itemId: String?) {
        guard !seen.contains(candidate.id) else { return ("CHAT", nil) }
        switch try candidate.record() {
        case let .item(_, card): return (card.project, card.itemId)
        case let .update(_, project, itemId, _, _): return (project, itemId)
        case let .answer(value): return (try value.required("project").text, try value.required("itemId").text)
        case nil:
            if let reply = candidate.replyTo {
                let sender = try reply.required("senderDid").text, tid = try reply.required("messageId").text
                for (key, prefs) in preferences {
                    guard let ref = prefs.outgoingRef, ref["senderDid"] == .string(sender), ref["messageId"] == .string(tid), let answer = prefs.answer else { continue }
                    let project = try answer.required("project").text, itemId = try answer.required("itemId").text
                    if try inboxThreadKey(sender: candidate.threadPeer, project: project, itemId: itemId) == key { return (project, itemId) }
                }
                if let original = messages.first(where: { $0.id == sender + "/" + tid && $0.threadPeer == candidate.threadPeer }) {
                    return try resolve(original, seen: seen.union([candidate.id]))
                }
            }
            return ("CHAT", nil)
        }
    }
    return try resolve(mail, seen: [])
}
@discardableResult
func appendInboxMessage(_ mail: MailItem, messages: inout [MailItem], preferences: inout [String: ThreadPreferences]) throws -> Bool {
    guard !messages.contains(where: { $0.id == mail.id }) else { return false }
    let address = try inboxThreadAddress(mail, messages: messages, preferences: preferences)
    let key = try inboxThreadKey(sender: mail.threadPeer, project: address.project, itemId: address.itemId)
    messages.append(mail)
    if var prefs = preferences[key] { prefs.received(); preferences[key] = prefs }
    return true
}
func inboxThreads(_ messages: [MailItem], preferences: [String: ThreadPreferences]) throws -> [InboxThread] {
    var threads: [InboxThread] = []
    for mail in messages {
        let record = try mail.record()
        let (project, itemId) = try inboxThreadAddress(mail, messages: messages, preferences: preferences)
        // JSON array keys are unambiguous even if a project/item contains '/'.
        let id = try inboxThreadKey(sender: mail.threadPeer, project: project, itemId: itemId)
        if !threads.contains(where: { $0.id == id }) { threads.append(InboxThread(id: id, sender: mail.threadPeer, project: project, itemId: itemId)) }
        guard let index = threads.firstIndex(where: { $0.id == id }) else { continue }
        threads[index].mailIds.append(mail.id)
        switch record {
        case let .item(_, card):
            // First card owns the thread. Revised decisions get a new item id.
            if threads[index].card == nil { threads[index].card = card; threads[index].cardTid = try mail.message.required("messageId").text }
            threads[index].latestSummary = InboxThread.firstLine(card.why)
            if let previous = card.supersedes, let old = threads.firstIndex(where: { $0.sender == mail.sender && $0.project == project && $0.itemId == previous }) { threads[old].state = threadState(threads[old].state, .superseded) }
        case let .update(_, _, _, state, text):
            threads[index].state = threadState(threads[index].state, state == "resolved" ? .resolved : state == "superseded" ? .superseded : .followup)
            if let text { threads[index].lines.append(text) }
            threads[index].latestSummary = InboxThread.firstLine(text ?? state)
        case let .answer(value):
            let options = try value.required("values").object().sorted { $0.key < $1.key }.map { try $0.key + ": " + $0.value.text }
            let line = "Reply: " + options.joined(separator: ", ")
            let note = try value["note"]?.text
            threads[index].lines.append(line + (note.map { "\n" + $0 } ?? "")); threads[index].latestSummary = InboxThread.firstLine(note ?? line)
        default:
            let line = (mail.outgoingTo == nil ? "" : "YOU: ") + mail.text
            threads[index].lines.append(line); threads[index].latestSummary = InboxThread.firstLine(line)
        }
    }
    // Apply supersession again so it does not depend on mailbox arrival order.
    let supersessions = threads.compactMap { thread -> (String, String, String)? in
        guard let previous = thread.card?.supersedes else { return nil }; return (thread.sender, thread.project, previous)
    }
    for (sender, project, previous) in supersessions {
        for index in threads.indices where threads[index].sender == sender && threads[index].project == project && threads[index].itemId == previous { threads[index].state = .superseded }
    }
    for index in threads.indices {
        if let prefs = preferences[threads[index].id] {
            if threads[index].state == .open { threads[index].state = prefs.state }
            threads[index].archived = prefs.archived
            if threads[index].state == .open || threads[index].state == .sent { threads[index].snoozedUntil = prefs.snoozedUntil }
        }
    }
    return threads
}
enum SnoozeChoice: String, CaseIterable, Identifiable {
    case hour = "1 HOUR", tonight = "TONIGHT 18:00", tomorrow = "TOMORROW 09:00", week = "NEXT WEEK"
    var id: String { rawValue }
    func date(from now: Date, calendar: Calendar = .current) -> Date {
        switch self {
        case .hour: return now.addingTimeInterval(3600)
        case .tonight: return calendar.nextDate(after: now, matching: DateComponents(hour: 18, minute: 0, second: 0), matchingPolicy: .nextTime) ?? now.addingTimeInterval(86400)
        case .tomorrow:
            let day = calendar.date(byAdding: .day, value: 1, to: calendar.startOfDay(for: now)) ?? now.addingTimeInterval(86400)
            return calendar.date(bySettingHour: 9, minute: 0, second: 0, of: day) ?? day
        case .week: return calendar.date(byAdding: .day, value: 7, to: now) ?? now.addingTimeInterval(604800)
        }
    }
}
