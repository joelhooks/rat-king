#if DEBUG
import SwiftUI

private struct InboxBenchmarkPaintKey: EnvironmentKey {
    static let defaultValue: (@MainActor () -> Void)? = nil
}

extension EnvironmentValues {
    var inboxBenchmarkPaint: (@MainActor () -> Void)? {
        get { self[InboxBenchmarkPaintKey.self] }
        set { self[InboxBenchmarkPaintKey.self] = newValue }
    }
}

struct InboxBenchmarkView: View {
    private static let start = ProcessInfo.processInfo.systemUptime
    static func markLaunch() { _ = start }
    @State private var store = InboxStore(preview: "did:web:phone.example.invalid", peers: [], messages: [])
    @State private var filters = ListFilters()
    @State private var rowsFetched = 0
    @State private var paintTime: Double?
    @State private var failure: String?

    var body: some View {
        VStack(spacing: 0) {
            ConversationsView(store: store, filters: filters)
                .environment(\.inboxBenchmarkPaint, {
                    if paintTime == nil { paintTime = (ProcessInfo.processInfo.systemUptime - Self.start) * 1_000 }
                })
            if let paintTime {
                Text("\(rowsFetched) \(paintTime)").accessibilityIdentifier("inbox-benchmark-result")
            }
            if let failure { Text(failure).accessibilityIdentifier("inbox-benchmark-error") }
        }
        .font(TUITheme.monoFont).foregroundStyle(TUITheme.fg).background(TUITheme.bg)
        .task { await seed() }
    }

    private func seed() async {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        do {
            let storage = try ProtectedLocalStore(directory: directory)
            var messages: [MailItem] = []
            func fetch(_ range: [Int64]) async throws -> [Value] {
                try await Task.sleep(for: .milliseconds(15))
                rowsFetched += range.count
                return range.map { .map(["seq": .int($0)]) }
            }
            func save(_ events: [Value], cursor: InboxCursor) throws {
                for event in events {
                    let seq = try event.required("seq").number
                    let sender = "did:web:sample-project.peer\(seq % 31).pi.example.invalid"
                    let id = "bench-\(seq)"
                    messages.append(MailItem(id: sender + "/" + id, message: .map(["senderDid": .string(sender), "messageId": .string(id)]),
                                             sender: sender, text: "Synthetic message \(seq)", receipt: "delivered"))
                }
                try storage.write("inbox.json", bytes: inboxFile(messages: messages, copies: [], preferences: [:], cursor: cursor).jsonData())
            }
            if ProcessInfo.processInfo.arguments.contains("--legacy") {
                for after in stride(from: Int64(0), to: 500, by: 100) {
                    try await save(fetch(Array((after + 1)...(after + 100))), cursor: InboxCursor(through: after == 400 ? 500 : nil))
                }
            } else {
                try await syncInbox(from: InboxCursor(), list: { read in
                    guard read == .newest else { throw ProtocolError.invalid("Unexpected startup request") }
                    let events = try await fetch(Array((451...500).reversed()))
                    let messages = try events.map { event in
                        Value.map(["admissionSeq": try event.required("seq"), "envelope": .map([:]), "receipt": .map([:])])
                    }
                    return try InboxPage(.map(["latestSeq": .int(500), "nextBeforeSeq": .int(451), "events": .array([]), "messages": .array(messages)]), request: read)
                }, commit: { _, events, cursor in try save(events, cursor: cursor) })
            }
            store.replaceBenchmarkMessages(messages)
        } catch { failure = error.localizedDescription }
    }
}
#endif
