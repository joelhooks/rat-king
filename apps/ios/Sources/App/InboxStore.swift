import CryptoKit
import Foundation
import Observation

// Native projection of packages/mailbox-client/src/watch.ts's auth-ready/list/live
// lifecycle. The desk approved the Swift projection instead of embedding XState.
enum ConnectionState: String { case stopped, acquiring, authenticating, catchingUp, live, retrying }
enum ConnectionEvent { case start, leaseReady, socketReady, notice, caughtUp, lost, background }
func nextState(_ state: ConnectionState, _ event: ConnectionEvent) -> ConnectionState {
    switch (state, event) {
    case (_, .background): return .stopped
    case (.stopped, .start), (.retrying, .start): return .acquiring
    case (.acquiring, .leaseReady): return .authenticating
    case (.authenticating, .socketReady), (.live, .notice): return .catchingUp
    case (.catchingUp, .caughtUp): return .live
    case (.acquiring, .lost), (.authenticating, .lost), (.catchingUp, .lost), (.live, .lost): return .retrying
    default: return state
    }
}
struct MailItem: Identifiable {
    let id: String
    let message: Value
    let sender: String
    let text: String
    var receipt: String
}
@MainActor @Observable
final class InboxStore {
    private(set) var state: ConnectionState = .stopped
    private(set) var identity: PhoneIdentity?
    private(set) var messages: [MailItem] = []
    private(set) var peers: [String: DIDDocument] = [:]
    private(set) var lastError: String?
    private(set) var sending = false
    private(set) var hasPendingSend = false
    private(set) var lastSend: String?
    private var client: Mailbox?
    private var lease: Lease?
    private var run: Task<Void, Never>?
    private var socket: URLSessionWebSocketTask?
    private var generation: UInt64 = 0
    private var through: Int64 = 0
    private var pending: Value?
    private var lastTid: UInt64 = 0

    init() {
        do {
            let configuration = try ClientConfiguration.load()
            let id = try PhoneIdentity(did: configuration.did)
            identity = id; client = Mailbox(configuration: configuration, identity: id)
            if let data = try readLocal("peers.json") { try installPeers(data, save: false) }
            if let url = Bundle.main.url(forResource: "PeerDocuments.private", withExtension: "json") { try installPeers(Data(contentsOf: url), save: false) }
            if let data = try readLocal("outbox.json") { pending = try Value.json(data); hasPendingSend = true }
        } catch { lastError = error.localizedDescription }
    }
    var publicDocument: String { guard let identity, let data = try? identity.document.jsonData() else { return "Identity unavailable" }; return String(decoding: data, as: UTF8.self) }
    private func directory() throws -> URL {
        let dir = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true).appendingPathComponent("RatKing", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        var values = URLResourceValues(); values.isExcludedFromBackup = true; var url = dir; try url.setResourceValues(values)
        return dir
    }
    private func readLocal(_ name: String) throws -> Data? {
        let url = try directory().appendingPathComponent(name)
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }; return try Data(contentsOf: url)
    }
    private func writeLocal(_ name: String, _ bytes: Data) throws { try bytes.write(to: directory().appendingPathComponent(name), options: [.atomic, .completeFileProtection]) }
    func importPeers(_ bytes: Data) { do { try installPeers(bytes, save: true); lastError = nil } catch { lastError = error.localizedDescription } }
    private func installPeers(_ bytes: Data, save: Bool) throws {
        guard bytes.count <= 200_000 else { throw ProtocolError.invalid("Peer document file too large") }
        let value = try Value.json(bytes)
        let docs: [Value]; if case let .array(a) = value { docs = a } else { docs = [value] }
        var updated = peers
        for doc in docs {
            let document = try DIDDocument(doc)
            _ = try document.encryptionKey()
            for id in try doc.required("authentication").list() { _ = try document.signingKey(id.text) }
            updated[try document.did] = document
        }
        if save { try writeLocal("peers.json", Value.array(updated.values.map(\.value)).jsonData()) }
        peers = updated
    }
    private func move(_ event: ConnectionEvent) { state = nextState(state, event) }
    private func current(_ token: UInt64) throws { try Task.checkCancellation(); guard generation == token else { throw CancellationError() } }
    func start() {
        guard run == nil, let client else { return }
        generation &+= 1; let token = generation
        run = Task { [weak self] in await self?.connect(client, token: token) }
    }
    func stop() {
        generation &+= 1; run?.cancel(); run = nil
        socket?.cancel(with: .goingAway, reason: nil); socket = nil
        move(.background)
        // Lease expires within five minutes. Retain its fence for a fast foreground
        // resume; no unowned background task or operator credential is needed.
    }
    private func connect(_ client: Mailbox, token: UInt64) async {
        var delay = 1
        while !Task.isCancelled, generation == token {
            do {
                move(.start)
                let acquired: Lease
                if let previous = lease, previous.expiresAt > Date() {
                    acquired = try await client.renew(previous)
                } else { acquired = try await client.acquire() }
                try current(token); lease = acquired
                let lease = acquired
                move(.leaseReady)
                let ws = try client.socket(lease); socket = ws; ws.resume()
                try await client.authenticate(ws)
                // Ready barrier comes before the first list; JWT is never in URL.
                _ = try await client.notice(ws); try current(token); move(.socketReady)
                try await catchUp(client, lease: lease, token: token); try current(token); move(.caughtUp)
                lastError = nil; delay = 1
                try await withThrowingTaskGroup(of: Void.self) { group in
                    group.addTask { [weak self] in
                        while !Task.isCancelled {
                            try await Task.sleep(for: .seconds(120))
                            try await self?.renew(client, token: token)
                        }
                    }
                    group.addTask { [weak self] in
                        while !Task.isCancelled {
                            _ = try await client.notice(ws)
                            try await self?.update(client, token: token)
                        }
                    }
                    do { _ = try await group.next(); group.cancelAll() }
                    catch { ws.cancel(with: .goingAway, reason: nil); group.cancelAll(); throw error }
                }
            } catch {
                guard generation == token, !Task.isCancelled else { return }
                socket?.cancel(with: .goingAway, reason: nil); socket = nil
                lastError = state.rawValue.uppercased() + ": " + error.localizedDescription; move(.lost)
                if let error = error as? XRPCError, error.code == "LeaseMismatch" { lease = nil }
                do { try await Task.sleep(for: .seconds(delay)) } catch { return }; delay = min(delay * 2, 30)
            }
        }
    }
    private func renew(_ client: Mailbox, token: UInt64) async throws {
        try current(token); guard let lease else { throw ProtocolError.invalid("Missing lease") }
        let renewed = try await client.renew(lease); try current(token); self.lease = renewed
    }
    private func update(_ client: Mailbox, token: UInt64) async throws {
        try current(token); guard let lease else { throw ProtocolError.invalid("Missing lease") }
        move(.notice); try await catchUp(client, lease: lease, token: token); try current(token); move(.caughtUp)
    }
    private func catchUp(_ client: Mailbox, lease: Lease, token: UInt64) async throws {
        let after = through; var cursor: String?; var watermark: Int64?
        repeat {
            var params = ["recipientDid": client.identity.did, "afterSeq": String(after), "limit": "100"]
            if let cursor { params["cursor"] = cursor }
            let page = try await client.call("mailbox.list", params: params); try current(token)
            let high = try page.required("throughSeq").number
            guard high >= after, watermark == nil || watermark == high else { throw ProtocolError.invalid("Snapshot watermark changed") }; watermark = high
            for event in try page.required("events").list() { try await process(event, client: client, lease: lease, token: token) }
            cursor = try page["cursor"]?.text
        } while cursor != nil
        try current(token); through = watermark ?? through
        // No disk checkpoint: on process restart replay encrypted history from zero.
        // Decrypted bodies never go to disk, logs, backups, or a notification.
    }
    private func process(_ event: Value, client: Mailbox, lease: Lease, token: UInt64) async throws {
        let receipt = try event.required("receipt"), message = try receipt.required("message")
        let sender = try message.required("senderDid").text, tid = try message.required("messageId").text
        let id = sender + "/" + tid, status = try receipt.required("state").text
        if let index = messages.firstIndex(where: { $0.id == id }) { messages[index].receipt = status }
        guard let envelope = event["envelope"] else {
            guard event["$type"] == .string(Mailbox.namespace + "defs#receiptEvent") else { throw ProtocolError.invalid("Unknown mailbox event") }; return
        }
        guard event["$type"] == .string(Mailbox.namespace + "defs#messageEvent") else { throw ProtocolError.invalid("Unknown mailbox event") }
        guard messages.allSatisfy({ $0.id != id }) else { return }
        let aad = try envelope.required("aad")
        guard aad["senderDid"] == .string(sender), aad["messageId"] == .string(tid) else { throw ProtocolError.invalid("Receipt/envelope mismatch") }
        let payload = try Envelope.open(envelope, did: client.identity.did, keyId: client.identity.encryptionId, key: client.identity.encryption) { did, id in
            guard let peer = peers[did] else { throw ProtocolError.invalid("Import the sender's public DID document before reading") }; return try peer.signingKey(id)
        }
        let body = try payload.required("body").data
        let text = String(data: body, encoding: .utf8) ?? "[binary: \(body.count) bytes]"
        var displayed = status
        if status == "accepted" || status == "queued" {
            do {
                let delivered = try await client.transition("deliver", message: message, lease: lease); try current(token)
                displayed = try delivered.required("state").text
            } catch let error as XRPCError where error.code == "InvalidTransition" {
                // Admission events are immutable; the current message may already
                // be acked/expired. Its later receipt event supplies the real state.
                // Never offer ACK for this unresolved historical state.
                displayed = "historical"
            }
        }
        try current(token); messages.append(MailItem(id: id, message: message, sender: sender, text: text, receipt: displayed))
    }
    func acknowledge(_ item: MailItem) async {
        guard state == .live, let client, let lease else { return }; let token = generation
        do {
            let receipt = try await client.transition("ack", message: item.message, lease: lease); try current(token)
            if let i = messages.firstIndex(where: { $0.id == item.id }) { messages[i].receipt = try receipt.required("state").text }
        } catch { if generation == token { lastError = error.localizedDescription } }
    }
    private func tid() -> String {
        let timestamp = UInt64(Date().timeIntervalSince1970 * 1_000_000)
        var value = (timestamp << 10) | UInt64(UInt16.random(in: 0..<1024))
        if value <= lastTid { value = lastTid + 1 }; lastTid = value
        let alphabet = Array("234567abcdefghijklmnopqrstuvwxyz"); var result = ""
        for _ in 0..<13 { result.insert(alphabet[Int(value & 31)], at: result.startIndex); value >>= 5 }; return result
    }
    func send(to did: String, text: String) async {
        guard state == .live, !sending, let client, let lease else { return }
        sending = true; defer { sending = false }; let token = generation
        do {
            if pending == nil {
                guard text.utf8.count <= 60_000, !text.isEmpty, let peer = peers[did] else { throw ProtocolError.invalid("Select an imported peer and enter a message (up to 60 KB)") }
                let (id, key) = try peer.encryptionKey()
                let payload: Value = .map(["version": .int(1), "suite": Envelope.suite, "aad": .map(["senderDid": .string(client.identity.did), "recipientDid": .string(did), "recipientKeyId": .string(id), "messageId": .string(tid())]), "body": .bytes(Data(text.utf8))])
                let sealed = try Envelope.seal(payload: payload, signingKeyId: client.identity.signingId, sign: client.identity.sign, recipient: key)
                try writeLocal("outbox.json", sealed.jsonData()); pending = sealed; hasPendingSend = true
            }
            guard let pending else { return }
            var body = lease.fence; body["envelope"] = pending
            let receipt = try await client.call("mailbox.send", body: .map(body)).required("receipt"); try current(token)
            try FileManager.default.removeItem(at: directory().appendingPathComponent("outbox.json"))
            self.pending = nil; hasPendingSend = false; lastSend = try receipt.required("state").text; lastError = nil
        } catch { if generation == token { lastError = error.localizedDescription } }
    }
}
