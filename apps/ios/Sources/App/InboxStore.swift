import CryptoKit
import Foundation
import Observation
import UserNotifications

// Native projection of packages/mailbox-client/src/watch.ts's auth-ready/list/live
// lifecycle. The desk approved the Swift projection instead of embedding XState.
enum ConnectionState: String { case stopped, acquiring, waiting, authenticating, catchingUp, live, retrying }
enum ConnectionEvent { case start, held, leaseReady, socketReady, notice, caughtUp, lost, background }
func nextState(_ state: ConnectionState, _ event: ConnectionEvent) -> ConnectionState {
    switch (state, event) {
    case (_, .background): return .stopped
    case (.stopped, .start), (.retrying, .start), (.waiting, .start): return .acquiring
    case (.acquiring, .held): return .waiting
    case (.acquiring, .leaseReady): return .authenticating
    case (.authenticating, .socketReady), (.live, .notice): return .catchingUp
    case (.catchingUp, .caughtUp): return .live
    case (.acquiring, .lost), (.waiting, .lost), (.authenticating, .lost), (.catchingUp, .lost), (.live, .lost): return .retrying
    default: return state
    }
}
struct MailItem: Identifiable {
    let id: String
    let message: Value
    let sender: String
    let text: String
    var receipt: String
    let replyTo: Value?
    func record() throws -> DeskRecord? {
        guard let bytes = text.data(using: .utf8), let value = try? Value.json(bytes) else { return nil }
        return try DeskRecord.decode(value)
    }
    var wire: Value {
        var fields: [String: Value] = ["id": .string(id), "message": message, "sender": .string(sender), "text": .string(text), "receipt": .string(receipt)]
        if let replyTo { fields["replyTo"] = replyTo }
        return .map(fields)
    }
    init(id: String, message: Value, sender: String, text: String, receipt: String, replyTo: Value? = nil) { self.id = id; self.message = message; self.sender = sender; self.text = text; self.receipt = receipt; self.replyTo = replyTo }
    init(_ value: Value) throws {
        self.init(id: try value.required("id").text, message: try value.required("message"), sender: try value.required("sender").text, text: try value.required("text").text, receipt: try value.required("receipt").text, replyTo: value["replyTo"])
        _ = try record()
        if let replyTo { _ = try replyTo.required("senderDid").text; _ = try replyTo.required("messageId").text }
    }
}
@MainActor @Observable
final class InboxStore {
    private(set) var state: ConnectionState = .stopped
    private(set) var identity: PhoneIdentity?
    private(set) var traffic: TrafficStore?
    private(set) var messages: [MailItem] = []
    private(set) var copies: [CarbonCopy] = []
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
    private var storageScope: String?
    private(set) var previousSession: LeaseWait?
    var waitingMessage: String? { previousSession?.message(at: now) }
    private(set) var preferences: [String: ThreadPreferences] = [:]
    private(set) var now = Date()
    private var snoozeTimer: Task<Void, Never>?
    var threads: [InboxThread] { (try? inboxThreads(messages, preferences: preferences)) ?? [] }

    init() {
        do {
            let configuration = try ClientConfiguration.load()
            storageScope = Self.scope(did: configuration.did, audience: configuration.audience)
            let id = try PhoneIdentity(did: configuration.did)
            identity = id; let mailbox = Mailbox(configuration: configuration, identity: id); client = mailbox
            traffic = TrafficStore(transport: mailbox.trafficTransport())
            if let data = try readLocal("peers.json") { try installPeers(data, save: false) }
            if let url = Bundle.main.url(forResource: "PeerDocuments.private", withExtension: "json") { try installPeers(Data(contentsOf: url), save: false) }
            if let data = try readLocal("outbox.json") { pending = try Value.json(data); hasPendingSend = true }
            if let data = try readLocal("inbox.json") {
                let saved = try Value.json(data)
                messages = try saved.required("messages").list().map(MailItem.init)
                preferences = try saved.required("preferences").object().mapValues(ThreadPreferences.init)
                copies = try saved["copies"]?.list().map(CarbonCopy.init) ?? []
            } else {
                // A fresh transport has no local threads to remind about. Retire
                // previous-network reminders without deleting its stored inbox.
                let notifications = UNUserNotificationCenter.current()
                notifications.removeAllPendingNotificationRequests(); notifications.removeAllDeliveredNotifications()
            }
        } catch { client = nil; lastError = error.localizedDescription }
    }
    var publicDocument: String { guard let identity, let data = try? identity.document.jsonData() else { return "Identity unavailable" }; return String(decoding: data, as: UTF8.self) }
    static func scope(did: String, audience: String) -> String {
        SHA256.hash(data: Data((did + "\n" + audience).utf8)).map { String(format: "%02x", $0) }.joined()
    }
    private func directory() throws -> URL {
        let dir = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true).appendingPathComponent("RatKing", isDirectory: true)
        guard let storageScope else { throw ProtocolError.invalid("Missing local transport scope") }
        return try ProtectedLocalStore(directory: dir.appendingPathComponent(storageScope, isDirectory: true)).directory
    }
    private func readLocal(_ name: String) throws -> Data? {
        try ProtectedLocalStore(directory: directory()).read(name)
    }
    private func writeLocal(_ name: String, _ bytes: Data) throws { try ProtectedLocalStore(directory: directory()).write(name, bytes: bytes) }
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
        now = Date(); armSnoozeTimer()
        generation &+= 1; let token = generation
        run = Task { [weak self] in await self?.connect(client, token: token) }
    }
    func stop() {
        traffic?.stop()
        generation &+= 1; run?.cancel(); run = nil
        snoozeTimer?.cancel(); snoozeTimer = nil
        socket?.cancel(with: .goingAway, reason: nil); socket = nil
        previousSession = nil; move(.background)
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
                if let held = error as? XRPCError, held.isLeaseHeld, state == .acquiring {
                    do {
                        let prior = try await client.resolveOwnLease(); try current(token)
                        lease = nil; lastError = nil; move(.held)
                        let wait = LeaseWait(until: prior.expiresAt); previousSession = wait
                        while wait.remaining(at: Date()) > 0 {
                            try current(token); now = Date()
                            try await Task.sleep(for: .seconds(max(0.01, min(1, prior.expiresAt.timeIntervalSinceNow))))
                        }
                        try current(token); previousSession = nil; now = Date(); continue
                    } catch {
                        guard generation == token, !Task.isCancelled else { return }
                        previousSession = nil
                        if let missing = error as? XRPCError, missing.code == "LeaseNotFound" { move(.lost); continue }
                        lastError = "LEASE LOOKUP: " + error.localizedDescription
                    }
                } else { lastError = state.rawValue.uppercased() + ": " + error.localizedDescription }
                move(.lost)
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
        // Replay encrypted history from zero. The protected local projection
        // deduplicates it; no decrypted text enters backups or notifications.
        try saveInbox()
    }
    private func process(_ event: Value, client: Mailbox, lease: Lease, token: UInt64) async throws {
        let receipt = try event.required("receipt"), message = try receipt.required("message")
        let sender = try message.required("senderDid").text, tid = try message.required("messageId").text
        let id = sender + "/" + tid, status = try receipt.required("state").text
        let kind = event["$type"]
        guard kind == .string(Mailbox.namespace + "defs#messageEvent") || kind == .string(Mailbox.namespace + "defs#receiptEvent") else { throw ProtocolError.invalid("Unknown mailbox event") }
        if let index = messages.firstIndex(where: { $0.id == id }) { messages[index].receipt = status; try saveInbox() }
        if let index = copies.firstIndex(where: { $0.id == id }) {
            copies[index].receipt = status; try saveInbox()
            try await receiveCopy(copies[index], client: client, lease: lease, token: token)
            return
        }
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
        let routed = try OpenedPhoneMessage.route(payload, message: message,
            time: receipt["time"].flatMap { try? $0.text } ?? ISO8601DateFormatter.fractional.string(from: Date()), receipt: status)
        let item: MailItem
        switch routed {
        case let .copy(copy):
            copies.append(copy); try saveInbox()
            try await receiveCopy(copy, client: client, lease: lease, token: token)
            return
        case let .mail(mail): item = mail
        }
        let text = item.text
        _ = try item.record()
        _ = try inboxThreadAddress(item, messages: messages, preferences: preferences)
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
        try current(token)
        let received = MailItem(id: id, message: message, sender: sender, text: text, receipt: displayed, replyTo: payload["replyTo"])
        let address = try inboxThreadAddress(received, messages: messages, preferences: preferences)
        guard try appendInboxMessage(received, messages: &messages, preferences: &preferences) else { return }
        let threadId = try inboxThreadKey(sender: sender, project: address.project, itemId: address.itemId)
        try saveInbox()
        let center = UNUserNotificationCenter.current()
        center.removePendingNotificationRequests(withIdentifiers: [threadId]); center.removeDeliveredNotifications(withIdentifiers: [threadId])
        now = Date(); armSnoozeTimer(); cancelClosedNotifications()
    }
    private func receiveCopy(_ copy: CarbonCopy, client: Mailbox, lease: Lease, token: UInt64) async throws {
        // Both transitions address only the independently sealed copy. Ack means
        // received by this phone, never that the primary recipient read it.
        var status = copy.receipt
        do {
            status = try await copy.receive { operation, message in
                let receipt = try await client.transition(operation, message: message, lease: lease); try current(token)
                return try receipt.required("state").text
            }
        } catch let error as XRPCError where error.code == "InvalidTransition" {
            status = "historical" // Later receipt events establish the real copy state.
        }
        if let index = copies.firstIndex(where: { $0.id == copy.id }) { copies[index].receipt = status; try saveInbox() }
    }
    func acknowledge(_ item: MailItem) async {
        guard state == .live, let client, let lease else { return }; let token = generation
        do {
            let receipt = try await client.transition("ack", message: item.message, lease: lease); try current(token)
            if let i = messages.firstIndex(where: { $0.id == item.id }) { messages[i].receipt = try receipt.required("state").text; try saveInbox() }
        } catch { if generation == token { lastError = error.localizedDescription } }
    }
    private func savePreferences(_ prefs: ThreadPreferences, for id: String) throws {
        let previous = preferences[id]; preferences[id] = prefs
        do { try saveInbox() } catch { preferences[id] = previous; throw error }
    }
    private func saveInbox() throws {
        try writeLocal("inbox.json", Value.map(["messages": .array(messages.map(\.wire)), "copies": .array(copies.map(\.wire)), "preferences": .map(preferences.mapValues(\.wire))]).jsonData())
    }
    func archive(_ thread: InboxThread) async {
        guard state == .live else { return }
        for item in messages.filter({ thread.mailIds.contains($0.id) && $0.receipt == "delivered" }) {
            await acknowledge(item)
            guard messages.first(where: { $0.id == item.id })?.receipt == "acked" else { return }
        }
        do {
            guard state == .live, threads.first(where: { $0.id == thread.id })?.mailIds == thread.mailIds else { return }
            var prefs = preferences[thread.id] ?? ThreadPreferences(); prefs.archived = true; prefs.snoozedUntil = nil
            try savePreferences(prefs, for: thread.id)
            UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: [thread.id])
        } catch { lastError = error.localizedDescription }
    }
    func restore(_ thread: InboxThread) {
        do {
            var prefs = preferences[thread.id] ?? ThreadPreferences(); prefs.archived = false
            try savePreferences(prefs, for: thread.id)
        } catch { lastError = error.localizedDescription }
    }
    func snooze(_ thread: InboxThread, choice: SnoozeChoice) async {
        guard thread.state == .open || thread.state == .sent else { return }
        do {
            let center = UNUserNotificationCenter.current()
            guard try await center.requestAuthorization(options: [.alert, .sound]) else { throw ProtocolError.invalid("Allow notifications to snooze with a reminder") }
            guard let current = threads.first(where: { $0.id == thread.id }), current.mailIds == thread.mailIds, current.state == .open || current.state == .sent else { return }
            let until = choice.date(from: Date())
            let content = UNMutableNotificationContent(); content.title = "Rat King"; content.body = "A snoozed thread is ready."; content.sound = .default
            try await center.add(UNNotificationRequest(identifier: thread.id, content: content, trigger: UNTimeIntervalNotificationTrigger(timeInterval: max(1, until.timeIntervalSinceNow), repeats: false)))
            guard threads.first(where: { $0.id == thread.id })?.mailIds == thread.mailIds else { center.removePendingNotificationRequests(withIdentifiers: [thread.id]); return }
            var prefs = preferences[thread.id] ?? ThreadPreferences(); prefs.snoozedUntil = until
            try savePreferences(prefs, for: thread.id); now = Date(); armSnoozeTimer()
        } catch {
            UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: [thread.id]); lastError = error.localizedDescription
        }
    }
    private func cancelClosedNotifications() {
        let closed = threads.filter { $0.state == .resolved || $0.state == .superseded }.map(\.id)
        let center = UNUserNotificationCenter.current()
        center.removePendingNotificationRequests(withIdentifiers: closed); center.removeDeliveredNotifications(withIdentifiers: closed)
    }
    private func armSnoozeTimer() {
        snoozeTimer?.cancel()
        guard let next = threads.compactMap(\.snoozedUntil).filter({ $0 > now }).min() else { return }
        snoozeTimer = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(max(0, next.timeIntervalSinceNow))) } catch { return }
            guard let self else { return }; self.now = Date(); self.armSnoozeTimer()
        }
    }
    private func tid() -> String {
        let timestamp = UInt64(Date().timeIntervalSince1970 * 1_000_000)
        var value = (timestamp << 10) | UInt64(UInt16.random(in: 0..<1024))
        if value <= lastTid { value = lastTid + 1 }; lastTid = value
        let alphabet = Array("234567abcdefghijklmnopqrstuvwxyz"); var result = ""
        for _ in 0..<13 { result.insert(alphabet[Int(value & 31)], at: result.startIndex); value >>= 5 }; return result
    }
    func send(to did: String, text: String) async {
        await sendBytes(to: did, bytes: Data(text.utf8))
    }
    func answer(_ thread: InboxThread, values: [String: String], rows: [String: [String]], note: String) async {
        guard !hasPendingSend, let currentThread = threads.first(where: { $0.id == thread.id }), currentThread.state == .open, let card = currentThread.card, let tid = currentThread.cardTid else { return }
        do {
            let record = try DeskRecord.answer(card: card, inReplyTo: tid, values: values, rows: rows, note: note)
            await sendBytes(to: thread.sender, bytes: try record.jsonData(), threadId: thread.id)
        } catch { lastError = error.localizedDescription }
    }
    private func sendBytes(to did: String, bytes: Data, threadId: String? = nil) async {
        guard state == .live, !sending, let client, let lease else { return }
        sending = true; defer { sending = false }; let token = generation
        do {
            if pending == nil {
                guard bytes.count <= 60_000, !bytes.isEmpty, let peer = peers[did] else { throw ProtocolError.invalid("Select an imported peer and enter a message (up to 60 KB)") }
                let (id, key) = try peer.encryptionKey()
                let payload: Value = .map(["version": .int(1), "suite": Envelope.suite, "aad": .map(["senderDid": .string(client.identity.did), "recipientDid": .string(did), "recipientKeyId": .string(id), "messageId": .string(tid())]), "body": .bytes(bytes)])
                let sealed = try Envelope.seal(payload: payload, signingKeyId: client.identity.signingId, sign: client.identity.sign, recipient: key)
                var saved: [String: Value] = ["envelope": sealed]
                if let threadId { saved["threadId"] = .string(threadId); saved["answer"] = try Value.json(bytes) }
                let entry = Value.map(saved)
                try writeLocal("outbox.json", entry.jsonData()); pending = entry; hasPendingSend = true
            }
            guard let pending else { return }
            // Legacy encrypted outbox entries remain retryable after upgrade.
            var body = lease.fence; body["envelope"] = pending["envelope"] ?? pending
            let receipt = try await client.call("mailbox.send", body: .map(body)).required("receipt"); try current(token)
            let accepted = try receipt.required("state").text
            guard ["accepted", "queued", "delivered", "acked"].contains(accepted) else { throw ProtocolError.invalid("Send not admitted: " + accepted) }
            if let target = try pending["threadId"]?.text {
                var prefs = preferences[target] ?? ThreadPreferences(); prefs.state = threadState(prefs.state, .answered); prefs.answer = pending["answer"]
                let aad = try (pending["envelope"] ?? pending).required("aad")
                prefs.outgoingRef = .map(["senderDid": try aad.required("senderDid"), "messageId": try aad.required("messageId")])
                try savePreferences(prefs, for: target)
            }
            try FileManager.default.removeItem(at: directory().appendingPathComponent("outbox.json"))
            self.pending = nil; hasPendingSend = false; lastSend = try receipt.required("state").text; lastError = nil
        } catch { if generation == token { lastError = error.localizedDescription } }
    }
}
