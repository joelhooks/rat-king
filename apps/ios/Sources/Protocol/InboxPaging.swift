import Foundation

struct InboxCursor: Equatable {
    var through: Int64?
    var before: Int64?

    init(through: Int64? = nil, before: Int64? = nil) {
        self.through = through
        self.before = before
    }

    init(_ file: Value) throws {
        if let value = file["paging"] {
            let through = try value.required("through").number
            let before = try value["before"]?.number
            guard through >= 0, before.map({ $0 > 0 && $0 <= through }) ?? true else {
                throw ProtocolError.invalid("Invalid inbox checkpoint")
            }
            self.init(through: through, before: before)
        } else {
            let legacy = try file["through"]?.number ?? 0
            self.init(through: legacy > 0 ? legacy : nil)
        }
    }

    var wire: Value {
        var fields: [String: Value] = ["through": .int(through ?? 0)]
        if let before { fields["before"] = .int(before) }
        return .map(fields)
    }
}

enum InboxRead: Equatable {
    case newest, older(Int64), since(Int64)

    static let size = 50

    var parameters: [String: String] {
        var params = ["limit": String(Self.size)]
        switch self {
        case .newest: break
        case let .older(seq): params["beforeSeq"] = String(seq)
        case let .since(seq): params["afterSeq"] = String(seq)
        }
        return params
    }

    var isForward: Bool {
        if case .since = self { return true }
        return false
    }
}

func eventMailID(_ event: Value) throws -> String {
    let message = try event.required("receipt").required("message")
    return try message.required("senderDid").text + "/" + message.required("messageId").text
}

struct InboxPage {
    let events: [Value]
    let latest: Int64
    let next: Int64?

    init(_ value: Value, request: InboxRead, limit: Int = InboxRead.size) throws {
        let latest = try value.required("latestSeq").number
        let log = try value.required("events").list()
        let events: [Value]
        if request.isForward {
            guard value["messages"] == nil else { throw ProtocolError.invalid("Unexpected inbox snapshot") }
            events = log
        } else {
            guard log.isEmpty else { throw ProtocolError.invalid("Unexpected inbox event log") }
            events = try value.required("messages").list().map { message in
                .map(["$type": .string(Mailbox.namespace + "defs#messageEvent"),
                      "seq": try message.required("admissionSeq"), "envelope": try message.required("envelope"),
                      "receipt": try message.required("receipt")])
            }
        }
        let before = try value["nextBeforeSeq"]?.number
        let after = try value["nextAfterSeq"]?.number
        guard latest >= 0, events.count <= limit else { throw ProtocolError.invalid("Invalid inbox page bounds") }
        var previous: Int64?
        switch request {
        case .newest: break
        case let .older(seq), let .since(seq): previous = seq
        }
        for event in events {
            let seq = try event.required("seq").number
            guard seq > 0, seq <= latest,
                  previous.map({ request.isForward ? seq > $0 : seq < $0 }) ?? true else {
                throw ProtocolError.invalid("Inbox events out of sequence")
            }
            previous = seq
        }
        let next = request.isForward ? after : before
        guard (request.isForward ? before : after) == nil,
              next.map({ !events.isEmpty && $0 == previous && (!request.isForward || $0 < latest) }) ?? true else {
            throw ProtocolError.invalid("Invalid inbox page cursor")
        }
        self.events = events
        self.latest = latest
        self.next = next
    }
}

@MainActor func syncInbox(from saved: InboxCursor, list: (InboxRead) async throws -> InboxPage,
                          commit: (InboxRead, [Value], InboxCursor) async throws -> Void) async throws {
    var cursor = saved
    var request = cursor.through.map(InboxRead.since) ?? .newest
    while true {
        try Task.checkCancellation()
        let page: InboxPage
        do { page = try await list(request) }
        catch let rpc as XRPCError where rpc.code == "InvalidCursor" && request == saved.through.map(InboxRead.since) {
            request = .newest
            continue
        }
        if case let .since(after) = request, page.latest < after {
            guard request == saved.through.map(InboxRead.since) else { throw ProtocolError.invalid("Inbox reset during catch-up") }
            request = .newest
            continue
        }
        if request.isForward {
            cursor.through = page.next ?? page.latest
        } else {
            cursor = InboxCursor(through: page.latest, before: page.next)
        }
        try await commit(request, request.isForward ? page.events : Array(page.events.reversed()), cursor)
        guard request.isForward, let next = page.next else { return }
        request = .since(next)
    }
}
