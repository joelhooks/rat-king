import Foundation
import Observation

// Native lifecycle projection: paused -> connecting -> catchingUp -> live.
// Loss closes the owned socket, then retrying -> connecting with a fresh JWT.
// Stop/denial -> paused. A generation fence rejects every late async result.
enum TrafficState: String { case paused, connecting, catchingUp, live, retrying }
enum TrafficEvent { case start, ready, notice, caughtUp, lost, stop }
func nextTrafficState(_ state: TrafficState, _ event: TrafficEvent) -> TrafficState {
    switch (state, event) {
    case (_, .stop): return .paused
    case (.paused, .start), (.retrying, .start): return .connecting
    case (.connecting, .ready), (.live, .notice): return .catchingUp
    case (.catchingUp, .caughtUp): return .live
    case (.connecting, .lost), (.catchingUp, .lost), (.live, .lost): return .retrying
    default: return state
    }
}
@MainActor @Observable final class TrafficStore {
    private(set) var state: TrafficState = .paused
    private(set) var lastError: String?
    private(set) var journal = TrafficJournal()
    private let transport: TrafficTransport
    private let wait: @Sendable (Int) async throws -> Void
    private var run: Task<Void, Never>?
    private var connection: TrafficConnection?
    private var generation: UInt64 = 0
    init(transport: TrafficTransport, wait: @escaping @Sendable (Int) async throws -> Void = { try await Task.sleep(for: .seconds($0)) }) { self.transport = transport; self.wait = wait }
    private func current(_ token: UInt64) throws { try Task.checkCancellation(); guard generation == token else { throw CancellationError() } }
    private func move(_ event: TrafficEvent) { state = nextTrafficState(state, event) }
    func start() {
        guard run == nil else { return }
        generation &+= 1; let token = generation
        run = Task { [weak self] in await self?.connect(token) }
    }
    func stop() {
        generation &+= 1; run?.cancel(); run = nil; connection?.close(); connection = nil; move(.stop)
    }
    private func catchUp(to watermark: Int64, token: UInt64) async throws {
        repeat {
            let page = try await transport.list(journal.cursor); try current(token)
            try journal.append(page)
            if journal.cursor >= watermark { return }
            guard !page.entries.isEmpty else { throw ProtocolError.invalid("Traffic watermark not reached") }
        } while true
    }
    private func connect(_ token: UInt64) async {
        var delay = 1
        while generation == token, !Task.isCancelled {
            do {
                move(.start)
                let opened = try transport.open(); connection = opened
                try await opened.authenticate(); try current(token)
                let watermark = try await opened.notice(); try current(token); move(.ready)
                try await catchUp(to: watermark, token: token); move(.caughtUp); lastError = nil; delay = 1
                while true {
                    let next = try await opened.notice(); try current(token)
                    if next <= journal.cursor { continue }
                    move(.notice); try await catchUp(to: next, token: token); move(.caughtUp)
                }
            } catch {
                guard generation == token, !Task.isCancelled else { return }
                connection?.close(); connection = nil; lastError = error.localizedDescription
                if let rpc = error as? XRPCError, rpc.status == 403 {
                    move(.stop); run = nil; return
                }
                move(.lost)
                do { try await wait(delay); try current(token) } catch { return }
                delay = min(delay * 2, 30)
            }
        }
    }
}
