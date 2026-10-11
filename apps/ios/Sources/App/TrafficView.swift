import SwiftUI

struct TrafficView: View {
    let store: TrafficStore
    var inbox: InboxStore?
    var copies: [CarbonCopy] = []
    private var unlinked: [CarbonCopy] { copies.filter { copy in !store.journal.entries.contains(where: copy.matches) } }
    @State private var path: [String] = []
    var body: some View {
        NavigationStack(path: $path) {
            VStack(alignment: .leading, spacing: 0) {
                HStack {
                    Text("● " + store.state.rawValue.uppercased()).foregroundStyle(store.state == .live ? TUITheme.ok : TUITheme.warn)
                    Spacer()
                    Button("[r reconnect]") { store.refresh() }.keyboardShortcut("r", modifiers: []).foregroundStyle(TUITheme.accent)
                }.padding(12)
                TerminalHints(text: "tap → details · edge swipe → back · pull → refresh")
                if let error = store.lastError { Text("! " + error).foregroundStyle(TUITheme.err).padding(12) }
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 0) {
                            Color.clear.frame(height: 1).id("top")
                            if store.presentation.loading {
                                Text("loading \(store.presentation.progress)…").foregroundStyle(TUITheme.warn).padding(12).accessibilityIdentifier("traffic-loading")
                            } else {
                                if !store.presentation.pending.isEmpty {
                                    Button("[\(store.presentation.pending.count) new ↑]") { store.revealNew(); proxy.scrollTo("top", anchor: .top) }.foregroundStyle(TUITheme.accent).padding(12)
                                }
                                if !store.archived.isEmpty { Button("[restore archived traffic]") { store.restoreAll() }.foregroundStyle(TUITheme.accent).padding(12) }
                                if store.rows.isEmpty { Text("No captured traffic yet. Capture starts at deploy.").foregroundStyle(TUITheme.dim).padding(12) }
                                ForEach(unlinked) { copy in
                                    TerminalPanel(title: "UNLINKED COPY") {
                                        CopyContentView(copy: copy)
                                        Text("No matching primary observed. Not attached to a traffic row.").foregroundStyle(TUITheme.warn)
                                    }.padding(12)
                                }
                                ForEach(store.rows, id: \.messageKey) { entry in
                                    Button { path.append(entry.messageKey) } label: { TrafficRow(entry: entry) }
                                        .buttonStyle(.plain).accessibilityIdentifier("traffic-row-\(entry.seq)")
                                        .accessibilityLabel("\(entry.time.formatted()), \(entry.senderDid) to \(entry.recipientDid), \(entry.messageId), \(entry.ciphertextSize) bytes, \(entry.state), details")
                                    ThinDivider()
                                }
                            }
                        }
                    }.refreshable { store.refresh() }
                }
            }.background(TUITheme.bg).toolbar(.hidden, for: .navigationBar)
            .navigationDestination(for: String.self) { key in
                if let selected = store.journal.messages.first(where: { $0.messageKey == key }) {
                    TrafficDetailView(detail: TrafficDetail(selected: selected, entries: store.journal.entries), inbox: inbox, copies: copies.filter { $0.matches(selected) }, archiveNext: {
                        let next = nextInboxID(after: key, in: store.rows.map(\.messageKey))
                        store.archive(key)
                        if let next { path = [next] } else { path = [] }
                    })
                }
            }
        }.font(TUITheme.monoFont).foregroundStyle(TUITheme.fg).tint(TUITheme.accent)
    }
}
private struct TrafficRow: View {
    let entry: TrafficEntry
    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .top, spacing: 8) {
                Text("›").foregroundStyle(TUITheme.accent)
                Text(entry.message?.label ?? entry.route).foregroundStyle(TUITheme.fg).lineLimit(2).frame(maxWidth: .infinity, alignment: .leading)
                Text(entry.state.uppercased()).foregroundStyle(TUITheme.receipt(entry.state)).font(TUITheme.microFont)
            }
            if entry.message?.label != nil { Text(entry.route).font(TUITheme.microFont).foregroundStyle(TUITheme.dim) }
            if let text = entry.message?.text { Text(text).foregroundStyle(TUITheme.fg).lineLimit(3) }
            Text(entry.messageId + " · \(entry.ciphertextSize) B").foregroundStyle(TUITheme.teal)
            Text(entry.time.formatted(date: .numeric, time: .standard) + " · #\(entry.seq)").font(TUITheme.microFont).foregroundStyle(TUITheme.dim)
        }.frame(maxWidth: .infinity, alignment: .leading).padding(12)
    }
}

struct TrafficDetailView: View {
    let detail: TrafficDetail
    var inbox: InboxStore?
    var copies: [CarbonCopy] = []
    var archiveNext: (() -> Void)?
    @Environment(\.dismiss) private var dismiss
    private func timestamp(_ date: Date) -> String { ISO8601DateFormatter.fractional.string(from: date) }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Button("[← back]") { dismiss() }.keyboardShortcut(.escape, modifiers: []).foregroundStyle(TUITheme.accent)
                if let archiveNext { Button("[ARCHIVE + NEXT]") { archiveNext() }.foregroundStyle(TUITheme.accent).accessibilityIdentifier("archive-next") }
                TerminalPanel(title: "MESSAGE / METADATA") {
                    if let label = detail.latest.message?.label { field("CALL SIGN", label) }
                    field("FROM", detail.selected.senderDid)
                    field("TO", detail.selected.recipientDid)
                    field("MESSAGE ID", detail.selected.messageId)
                    field("SEALED SIZE", "\(detail.selected.ciphertextSize) bytes")
                }
                TerminalPanel(title: "DELIVERY TIMELINE") {
                    Text("STATUS " + detail.latest.state.uppercased()).foregroundStyle(TUITheme.receipt(detail.latest.state))
                    Text("Observed times · UTC · \(detail.events.count) events").foregroundStyle(TUITheme.dim)
                    ForEach(detail.events) { event in
                        HStack(alignment: .top) {
                            Text(event.state.uppercased()).font(TUITheme.microFont).foregroundStyle(TUITheme.receipt(event.state))
                            VStack(alignment: .leading, spacing: 2) {
                                Text(timestamp(event.time)).textSelection(.enabled)
                                Text("journal #\(event.seq) · recipient #\(event.recipientSeq)").font(TUITheme.microFont).foregroundStyle(TUITheme.dim)
                            }
                        }
                    }
                }
                TerminalPanel(title: detail.latest.message != nil ? "MESSAGE TEXT / SIGNED PLAINTEXT" : copies.isEmpty ? "MESSAGE TEXT / NOT COPIED" : "MESSAGE TEXT / CC COPY") {
                    if let text = detail.latest.message?.text {
                        Text(text).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                        Text("Signature verified by the mailbox at admission.").foregroundStyle(TUITheme.dim)
                    } else if copies.isEmpty {
                        Text("content not copied to this phone").foregroundStyle(TUITheme.dim)
                    } else {
                        ForEach(copies) { copy in CopyContentView(copy: copy) }
                        Text("Copy received by this phone. Primary delivery is shown only in the journal above.").foregroundStyle(TUITheme.dim)
                    }
                }.accessibilityIdentifier("traffic-content-placeholder")
                if let inbox, detail.selected.senderDid != inbox.identity?.did {
                    let ref: Value = .map(["senderDid": .string(detail.selected.senderDid), "messageId": .string(detail.selected.messageId)])
                    ForEach(inbox.messages.filter { $0.outgoingTo == detail.selected.senderDid && $0.replyTo == ref }) { reply in
                        TerminalPanel(title: "YOU / " + reply.receipt.uppercased()) { TerminalMessage(text: reply.text) }
                    }
                    ReplyComposer(store: inbox, target: MailItem(id: detail.selected.senderDid + "/" + detail.selected.messageId, message: ref, sender: detail.selected.senderDid, text: detail.latest.body ?? "", receipt: detail.latest.state)).id(detail.selected.messageKey)
                }
            }.padding(12)
        }.background(TUITheme.bg).toolbar(.visible, for: .navigationBar)
        .toolbarBackground(TUITheme.bg, for: .navigationBar)
    }
    private func field(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label).font(TUITheme.microFont).foregroundStyle(TUITheme.dim)
            Text(value).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
        }
    }
}

struct CopyContentView: View {
    let copy: CarbonCopy
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(copy.linkValid ? "CC COPY / VERIFIED SENDER" : "CC COPY / UNLINKED").foregroundStyle(TUITheme.warn)
            Text("FROM " + copy.sender).textSelection(.enabled)
            Text("TO " + (copy.recipient ?? "unknown")).textSelection(.enabled)
            Text("PRIMARY " + (copy.primaryMessageId ?? "unknown")).foregroundStyle(TUITheme.dim)
            Text("COPY RECEIVED " + copy.time).font(TUITheme.microFont).foregroundStyle(TUITheme.dim)
            Text(copy.text).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
        }
    }
}
