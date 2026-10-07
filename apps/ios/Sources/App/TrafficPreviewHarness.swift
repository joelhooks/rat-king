#if DEBUG
import SwiftUI

// Synthetic, launch-only UI proof. No identity, mailbox or saved data.
struct TrafficPreviewHarness: View {
    @State private var store = TrafficStore(transport: TrafficPreviewHarness.transport)
    static let transport = TrafficTransport(open: {
        let notices = PreviewNotices()
        return TrafficConnection(authenticate: {}, notice: { try await notices.next() }, close: {})
    }, list: { cursor in
        let events: [Value] = cursor == 0 ? (1...4).map { seq in
            .map(["seq": .int(Int64(seq)), "recipientSeq": .int(Int64(seq)),
                "time": .string("2026-01-01T12:00:0\(seq).000Z"),
                "senderDid": .string("did:web:sample-sender.example.invalid"),
                "recipientDid": .string("did:web:sample-recipient.example.invalid"),
                "messageId": .string("3m5abcde23456"), "ciphertextSize": .int(1024),
                "state": .string(TrafficDetail.stages[seq - 1])])
        } : []
        return try TrafficPage(.map(["cursor": .string("4"), "events": .array(events)]))
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
        TrafficView(store: store, copies: copies)
            .preferredColorScheme(ProcessInfo.processInfo.arguments.contains("Dark") ? .dark : .light)
            .task { store.start() }.onDisappear { store.stop() }
    }
}
private actor PreviewNotices {
    private var ready = false
    func next() async throws -> Int64 {
        if !ready { ready = true; return 4 }
        try await Task.sleep(for: .seconds(3600)); return 4
    }
}
#endif
