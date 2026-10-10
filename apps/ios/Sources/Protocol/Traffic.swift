import Foundation

struct MessageText: Equatable, Sendable {
    let text: String; let label: String?
    init(_ raw: String) {
        guard let object = (try? JSONSerialization.jsonObject(with: Data(raw.utf8))) as? [String: Any],
              let body = object["body"] as? String, object["from"] is String else { text = raw; label = nil; return }
        text = body
        label = (object["label"] as? String).flatMap { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : $0 }
    }
}

struct TrafficEntry: Identifiable, Equatable, Sendable {
    let seq: Int64; let recipientSeq: Int64
    let time: Date; let senderDid: String; let recipientDid: String
    let messageId: String; let ciphertextSize: Int64; let state: String
    let body: String?
    var id: Int64 { seq }
    var message: MessageText? { body.map(MessageText.init) }
    var route: String { Self.shortName(senderDid) + " → " + Self.shortName(recipientDid) }
    init(_ value: Value) throws {
        seq = try value.required("seq").number; recipientSeq = try value.required("recipientSeq").number
        ciphertextSize = try value.required("ciphertextSize").number
        senderDid = try value.required("senderDid").text; recipientDid = try value.required("recipientDid").text
        messageId = try value.required("messageId").text; state = try value.required("state").text
        body = try value["body"]?.text
        let timestamp = try value.required("time").text
        guard let date = ISO8601DateFormatter.fractional.date(from: timestamp) ?? ISO8601DateFormatter().date(from: timestamp),
              (1...9_007_199_254_740_991).contains(seq), (1...9_007_199_254_740_991).contains(recipientSeq),
              (0...9_007_199_254_740_991).contains(ciphertextSize),
              senderDid.hasPrefix("did:"), recipientDid.hasPrefix("did:"),
              [senderDid, recipientDid, state].allSatisfy({ !$0.isEmpty && $0.count <= 2048 && !$0.contains(where: { $0.isNewline || $0.isWhitespace }) }),
              messageId.count == 13, messageId.allSatisfy({ "234567abcdefghijklmnopqrstuvwxyz".contains($0) }) else { throw ProtocolError.invalid("Invalid traffic metadata") }
        time = date
    }
    static func shortName(_ did: String) -> String {
        var name = did.hasPrefix("did:web:") ? String(did.dropFirst(8)) : did
        let suffix = ".ratking-fleet.invalid"
        if name.hasSuffix(suffix) { name = String(name.dropLast(suffix.count)) }
        return name
    }
}
struct TrafficPage: Sendable {
    let entries: [TrafficEntry]; let cursor: Int64
    init(_ value: Value) throws {
        let text = try value.required("cursor").text
        guard let parsed = Int64(text), (0...9_007_199_254_740_991).contains(parsed), String(parsed) == text else { throw ProtocolError.invalid("Invalid traffic cursor") }
        cursor = parsed; entries = try value.required("events").list().map(TrafficEntry.init)
        guard entries.count <= 100 else { throw ProtocolError.invalid("Traffic page too large") }
    }
}
struct TrafficJournal {
    private(set) var cursor: Int64 = 0
    private(set) var entries: [TrafficEntry] = []
    mutating func append(_ page: TrafficPage) throws {
        var previous = cursor
        for entry in page.entries {
            guard entry.seq > previous else { throw ProtocolError.invalid("Traffic sequence regressed") }; previous = entry.seq
        }
        guard page.cursor == previous else { throw ProtocolError.invalid("Traffic cursor does not match page") }
        // Commit the whole validated page, never a partial page or a notice watermark.
        entries.append(contentsOf: page.entries); cursor = page.cursor
    }
}

// Detail Lens: read-only projection. Identity is a message ID, never a list offset.
struct TrafficDetail: Sendable {
    static let stages = ["accepted", "queued", "delivered", "acked"]
    let selected: TrafficEntry
    let events: [TrafficEntry]
    init(selected: TrafficEntry, entries: [TrafficEntry]) {
        self.selected = selected
        events = entries.filter { $0.messageId == selected.messageId && $0.senderDid == selected.senderDid && $0.recipientDid == selected.recipientDid }.sorted { $0.seq < $1.seq }
    }
    func observations(for state: String) -> [TrafficEntry] { events.filter { $0.state == state } }
    var otherEvents: [TrafficEntry] { events.filter { !Self.stages.contains($0.state) } }
}

// Observer-shaped ports: there is no lease, delivery/ack operation or payload.
struct TrafficConnection: Sendable {
    let authenticate: @Sendable () async throws -> Void
    let notice: @Sendable () async throws -> Int64
    let close: @Sendable () -> Void
}
struct TrafficTransport: Sendable {
    let open: @Sendable () throws -> TrafficConnection
    let list: @Sendable (Int64) async throws -> TrafficPage
}
