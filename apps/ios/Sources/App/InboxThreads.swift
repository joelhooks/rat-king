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
    var title: String { card?.title ?? sender }
    func visible(at date: Date, archivedView: Bool) -> Bool { archivedView ? archived : !archived && (snoozedUntil.map { $0 <= date } ?? true) }
}
struct ThreadPreferences {
    var state: ThreadState = .open; var archived = false; var snoozedUntil: Date?
    var answer: Value?
    var wire: Value {
        var fields: [String: Value] = ["state": .string(state.rawValue), "archived": .bool(archived)]
        if let snoozedUntil { fields["snoozedUntil"] = .int(Int64(snoozedUntil.timeIntervalSince1970)) }
        if let answer { fields["answer"] = answer }
        return .map(fields)
    }
    init() {}
    init(_ value: Value) throws {
        guard let state = ThreadState(rawValue: try value.required("state").text), case let .bool(archived) = try value.required("archived") else { throw ProtocolError.invalid("Invalid thread preferences") }
        self.state = state; self.archived = archived
        if let saved = value["answer"] {
            guard case .answer = try DeskRecord.decode(saved) else { throw ProtocolError.invalid("Invalid saved desk answer") }; answer = saved
        }
        if let time = value["snoozedUntil"] { snoozedUntil = Date(timeIntervalSince1970: Double(try time.number)) }
    }
}
func inboxThreads(_ messages: [MailItem], preferences: [String: ThreadPreferences]) throws -> [InboxThread] {
    var threads: [InboxThread] = []
    for mail in messages {
        let record = try mail.record()
        let project: String; let itemId: String?
        switch record {
        case let .item(_, card): project = card.project; itemId = card.itemId
        case let .update(_, p, id, _, _): project = p; itemId = id
        case .answer: continue
        case nil: project = "CHAT"; itemId = nil
        }
        // JSON array keys are unambiguous even if a project/item contains '/'.
        let id = String(decoding: try Value.array([.string(mail.sender), .string(project), itemId.map(Value.string) ?? .null]).jsonData(), as: UTF8.self)
        if !threads.contains(where: { $0.id == id }) { threads.append(InboxThread(id: id, sender: mail.sender, project: project, itemId: itemId)) }
        guard let index = threads.firstIndex(where: { $0.id == id }) else { continue }
        threads[index].mailIds.append(mail.id)
        switch record {
        case let .item(_, card):
            // First card owns the thread. Revised decisions get a new item id.
            if threads[index].card == nil { threads[index].card = card; threads[index].cardTid = try mail.message.required("messageId").text }
            if let previous = card.supersedes, let old = threads.firstIndex(where: { $0.sender == mail.sender && $0.project == project && $0.itemId == previous }) { threads[old].state = threadState(threads[old].state, .superseded) }
        case let .update(_, _, _, state, text):
            threads[index].state = threadState(threads[index].state, state == "resolved" ? .resolved : state == "superseded" ? .superseded : .followup)
            if let text { threads[index].lines.append(text) }
        default: threads[index].lines.append(mail.text)
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
