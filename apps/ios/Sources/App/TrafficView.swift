import SwiftUI

struct TrafficView: View {
    let store: TrafficStore
    @State private var path: [Int64] = []
    var body: some View {
        NavigationStack(path: $path) {
            VStack(alignment: .leading, spacing: 0) {
                HStack {
                    Text("● " + store.state.rawValue.uppercased()).foregroundStyle(store.state == .live ? TUITheme.ok : TUITheme.warn)
                    Spacer()
                    Button("[r reconnect]") { store.stop(); store.start() }.keyboardShortcut("r", modifiers: []).foregroundStyle(TUITheme.accent)
                }.padding(12)
                TerminalHints(text: "tap row → details · metadata only")
                if let error = store.lastError { Text("! " + error).foregroundStyle(TUITheme.err).padding(12) }
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        if store.journal.entries.isEmpty {
                            Text("No captured traffic yet. Capture starts at deploy.").foregroundStyle(TUITheme.dim).padding(12)
                        }
                        ForEach(store.journal.entries.reversed()) { entry in
                            Button { path.append(entry.seq) } label: {
                                VStack(alignment: .leading, spacing: 5) {
                                    HStack(alignment: .top, spacing: 8) {
                                        Text("›").foregroundStyle(TUITheme.accent)
                                        Text(TrafficEntry.shortName(entry.senderDid) + " → " + TrafficEntry.shortName(entry.recipientDid))
                                            .foregroundStyle(TUITheme.fg).lineLimit(2).frame(maxWidth: .infinity, alignment: .leading)
                                        Text(entry.state.uppercased()).foregroundStyle(TUITheme.receipt(entry.state)).font(TUITheme.microFont)
                                    }
                                    Text(entry.messageId + " · \(entry.ciphertextSize) B").foregroundStyle(TUITheme.teal)
                                    Text(entry.time.formatted(date: .numeric, time: .standard) + " · #\(entry.seq)")
                                        .font(TUITheme.microFont).foregroundStyle(TUITheme.dim)
                                }.frame(maxWidth: .infinity, alignment: .leading).padding(12)
                            }.buttonStyle(.plain).accessibilityIdentifier("traffic-row-\(entry.seq)")
                            .accessibilityLabel("\(entry.time.formatted()), \(entry.senderDid) to \(entry.recipientDid), \(entry.messageId), \(entry.ciphertextSize) bytes, \(entry.state), details")
                            ThinDivider()
                        }
                    }
                }
            }.background(TUITheme.bg).toolbar(.hidden, for: .navigationBar)
            .navigationDestination(for: Int64.self) { seq in
                if let selected = store.journal.entries.first(where: { $0.seq == seq }) {
                    TrafficDetailView(detail: TrafficDetail(selected: selected, entries: store.journal.entries))
                }
            }
        }.font(TUITheme.monoFont).foregroundStyle(TUITheme.fg).tint(TUITheme.accent)
    }
}

struct TrafficDetailView: View {
    let detail: TrafficDetail
    @Environment(\.dismiss) private var dismiss
    private func timestamp(_ date: Date) -> String { ISO8601DateFormatter.fractional.string(from: date) }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Button("[← back]") { dismiss() }.keyboardShortcut(.escape, modifiers: []).foregroundStyle(TUITheme.accent)
                TerminalPanel(title: "MESSAGE / METADATA") {
                    field("FROM", detail.selected.senderDid)
                    field("TO", detail.selected.recipientDid)
                    field("MESSAGE ID", detail.selected.messageId)
                    field("SEALED SIZE", "\(detail.selected.ciphertextSize) bytes")
                }
                TerminalPanel(title: "DELIVERY TIMELINE") {
                    Text("Observed times · UTC · \(detail.events.count) events").foregroundStyle(TUITheme.dim)
                    ForEach(TrafficDetail.stages, id: \.self) { state in
                        let observations = detail.observations(for: state)
                        VStack(alignment: .leading, spacing: 4) {
                            Text((observations.isEmpty ? "○ " : "● ") + state.uppercased()).foregroundStyle(observations.isEmpty ? TUITheme.dim : TUITheme.receipt(state))
                            if observations.isEmpty { Text("not observed").foregroundStyle(TUITheme.dim) }
                            ForEach(observations) { event in observation(event) }
                        }
                    }
                    ForEach(detail.otherEvents) { event in
                        Text("! " + event.state.uppercased()).foregroundStyle(TUITheme.receipt(event.state))
                        observation(event)
                    }
                }
                TerminalPanel(title: "MESSAGE TEXT / NOT AVAILABLE") {
                    Text("Traffic contains metadata, not message text.").foregroundStyle(TUITheme.dim)
                    Text("A sealed copy to this phone is not enabled. Content policy is pending; no other agent's mail is decrypted here.").foregroundStyle(TUITheme.dim)
                }.accessibilityIdentifier("traffic-content-placeholder")
            }.padding(12)
        }.background(TUITheme.bg).toolbar(.hidden, for: .navigationBar)
    }
    private func field(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label).font(TUITheme.microFont).foregroundStyle(TUITheme.dim)
            Text(value).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
        }
    }
    private func observation(_ event: TrafficEntry) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(timestamp(event.time)).textSelection(.enabled)
            Text("journal #\(event.seq) · recipient #\(event.recipientSeq)").font(TUITheme.microFont).foregroundStyle(TUITheme.dim)
        }
    }
}
