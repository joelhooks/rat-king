#if DEBUG
import SwiftUI

// Synthetic, launch-only UI proof. No identity, mailbox or saved data.
struct TrafficPreviewHarness: View {
    @State private var store = TrafficStore(transport: TrafficPreviewHarness.transport)
    @State private var filter = ListFilter()
    static let transport = TrafficTransport(open: {
        let notices = PreviewNotices()
        return TrafficConnection(authenticate: {}, notice: { try await notices.next() }, close: {})
    }, list: { cursor in
        let count = ProcessInfo.processInfo.arguments.contains("--traffic-next-test") ? 5 : 4
        var events: [Value] = []
        if cursor == 0 {
            for seq in 1...count {
                let messageId = seq == 5 ? "3m5abcde23457" : "3m5abcde23456"
                let state = TrafficDetail.stages[(seq - 1) % 4]
                let fields: [String: Value] = ["seq": .int(Int64(seq)), "recipientSeq": .int(Int64(seq)),
                    "time": .string("2026-01-01T12:00:0\(seq).000Z"),
                    "senderDid": .string("did:web:sample-sender.example.invalid"),
                    "recipientDid": .string("did:web:sample-recipient.example.invalid"),
                    "messageId": .string(messageId), "ciphertextSize": .int(1024), "state": .string(state)]
                events.append(.map(fields))
            }
        }
        return try TrafficPage(.map(["cursor": .string(String(count)), "events": .array(events)]))
    })
    private var copies: [CarbonCopy] {
        guard ProcessInfo.processInfo.arguments.contains("--traffic-copy-test") else { return [] }
        let primary: Value = .map(["senderDid": .string("did:web:sample-sender.example.invalid"), "recipientDid": .string("did:web:sample-recipient.example.invalid"), "messageId": .string("3m5abcde23456")])
        guard let body = try? Value.map(["$type": .string(CarbonCopy.marker), "primary": primary, "body": .string("Synthetic copied content")]).jsonData(),
              let copy = try? CarbonCopy.decode(.map(["aad": .map(["senderDid": .string("did:web:sample-sender.example.invalid"), "recipientDid": .string("did:web:phone.example.invalid"), "messageId": .string("3m5abcde23457")]),
                "replyTo": .map(["senderDid": .string("did:web:sample-sender.example.invalid"), "messageId": .string("3m5abcde23456")]), "body": .bytes(body)]), time: "2026-01-01T12:00:05.000Z", receipt: "acked") else { return [] }
        return [copy]
    }
    var body: some View {
        TrafficView(store: store, copies: copies, filter: $filter)
            .preferredColorScheme(ProcessInfo.processInfo.arguments.contains("Dark") ? .dark : .light)
            .task { store.start() }.onDisappear { store.stop() }
    }
}
private actor PreviewNotices {
    private var ready = false
    func next() async throws -> Int64 {
        if !ready { ready = true; return ProcessInfo.processInfo.arguments.contains("--traffic-next-test") ? 5 : 4 }
        try await Task.sleep(for: .seconds(3600)); return 4
    }
}
#endif
