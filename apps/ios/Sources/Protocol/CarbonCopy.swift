import Foundation

// Construct only after Envelope.open has authenticated the sender and signed body.
// Even a malformed CC marker is isolated from Mail and desk records.
struct CarbonCopy: Identifiable, Equatable, Sendable {
    static let marker = "sh.mschf.ratking.mailbox.cc"
    let payload: Value
    let time: String
    let sender: String
    let copyMessageId: String
    let primaryMessageId: String?
    let recipient: String?
    let text: String
    let linkValid: Bool
    var receipt: String
    var id: String { sender + "/" + copyMessageId }
    var message: Value { .map(["senderDid": .string(sender), "messageId": .string(copyMessageId)]) }

    static func decode(_ payload: Value, time: String, receipt: String) throws -> CarbonCopy? {
        let bytes = try payload.required("body").data
        guard let object = (try? JSONSerialization.jsonObject(with: bytes)) as? [String: Any], object["$type"] as? String == marker else { return nil }
        let body = (try? Value.json(bytes)) ?? .map(["$type": .string(marker)])
        let aad = try payload.required("aad")
        let sender = try aad.required("senderDid").text
        let copyId = try aad.required("messageId").text
        let primary = body["primary"]
        let tid = try? primary?.required("messageId").text
        let recipient = try? primary?.required("recipientDid").text
        let primarySender = try? primary?.required("senderDid").text
        let text = (try? body.required("body").text) ?? "[invalid copy body]"
        let reply = payload["replyTo"]
        let valid = tid.map { $0.count == 13 && $0.allSatisfy { "234567abcdefghijklmnopqrstuvwxyz".contains($0) } && $0 != copyId } ?? false
        let linked = valid && primarySender == sender && recipient?.hasPrefix("did:web:") == true
            && recipient != (try? aad.required("recipientDid").text)
            && reply?["senderDid"] == .string(sender) && reply?["messageId"] == tid.map(Value.string)
            && (try? body.required("body").text) != nil
        return CarbonCopy(payload: payload, time: time, sender: sender, copyMessageId: copyId,
                          primaryMessageId: tid, recipient: recipient, text: text, linkValid: linked, receipt: receipt)
    }
    @MainActor func receive(transition: (String, Value) async throws -> String) async throws -> String {
        var status = receipt
        if status == "accepted" || status == "queued" { status = try await transition("deliver", message) }
        if status == "delivered" { status = try await transition("ack", message) }
        return status
    }
    func matches(_ entry: TrafficEntry) -> Bool {
        linkValid && primaryMessageId == entry.messageId && sender == entry.senderDid && recipient == entry.recipientDid
    }
    var wire: Value { .map(["payload": payload, "time": .string(time), "receipt": .string(receipt)]) }
    init(_ wire: Value) throws {
        guard let copy = try Self.decode(wire.required("payload"), time: wire.required("time").text, receipt: wire.required("receipt").text) else { throw ProtocolError.invalid("Invalid saved copy") }
        self = copy
    }
    private init(payload: Value, time: String, sender: String, copyMessageId: String, primaryMessageId: String?, recipient: String?, text: String, linkValid: Bool, receipt: String) {
        self.payload = payload; self.time = time; self.sender = sender; self.copyMessageId = copyMessageId
        self.primaryMessageId = primaryMessageId; self.recipient = recipient; self.text = text; self.linkValid = linkValid; self.receipt = receipt
    }
}

// One routing decision used by the real mailbox consumer. Copies never become
// MailItem values, so they cannot be threads, desk answers or primary receipts.
enum OpenedPhoneMessage {
    case copy(CarbonCopy)
    case mail(MailItem)
    static func route(_ payload: Value, message: Value, time: String, receipt: String) throws -> Self {
        if let copy = try CarbonCopy.decode(payload, time: time, receipt: receipt) { return .copy(copy) }
        let sender = try message.required("senderDid").text, tid = try message.required("messageId").text
        let bytes = try payload.required("body").data
        return .mail(MailItem(id: sender + "/" + tid, message: message, sender: sender,
                             text: String(data: bytes, encoding: .utf8) ?? "[binary: \(bytes.count) bytes]",
                             receipt: receipt, replyTo: payload["replyTo"]))
    }
}
