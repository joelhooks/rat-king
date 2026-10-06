import SwiftUI

struct TrafficView: View {
    let store: TrafficStore
    private func clock(_ date: Date) -> String { let f = DateFormatter(); f.dateFormat = "HH:mm:ss"; return f.string(from: date) }
    private func day(_ date: Date) -> String { let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd"; return f.string(from: date) }
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(store.state == .live ? "LIVE" : store.state == .paused ? "PAUSED" : "PAUSED / " + store.state.rawValue.uppercased()).foregroundStyle(store.state == .live ? TUITheme.ok : TUITheme.warn)
                Spacer()
                Button("[RECONNECT]") { store.stop(); store.start() }.foregroundStyle(TUITheme.accent)
            }.padding(.horizontal, 8).padding(.top, 6)
            Text("METADATA ONLY / CAPTURE STARTS AT DEPLOY").font(TUITheme.microFont).foregroundStyle(TUITheme.dim).padding(.horizontal, 8)
            if let error = store.lastError { Text("! " + error).foregroundStyle(TUITheme.err).padding(.horizontal, 8) }
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 3) {
                    if store.journal.entries.isEmpty { Text("No captured traffic yet.").foregroundStyle(TUITheme.dim) }
                    ForEach(store.journal.entries.reversed()) { entry in
                        VStack(alignment: .leading, spacing: 2) {
                            HStack(spacing: 5) {
                                Text(clock(entry.time)).foregroundStyle(TUITheme.dim)
                                Text(TrafficEntry.shortName(entry.senderDid) + " → " + TrafficEntry.shortName(entry.recipientDid)).foregroundStyle(TUITheme.teal).lineLimit(1)
                                Spacer(minLength: 0)
                                Text("\(entry.ciphertextSize) B").foregroundStyle(TUITheme.dim)
                                Text(entry.state.uppercased()).foregroundStyle(entry.state == "failed" || entry.state == "expired" ? TUITheme.err : TUITheme.accent)
                            }.lineLimit(1)
                            HStack(spacing: 6) {
                                Text(day(entry.time)); Text(entry.messageId).textSelection(.enabled)
                                Spacer(minLength: 0); Text("#\(entry.seq) / \(entry.recipientSeq)")
                            }.font(TUITheme.microFont).foregroundStyle(TUITheme.dim)
                        }.padding(.vertical, 3).padding(.horizontal, 6).background(TUITheme.panel)
                        .accessibilityElement(children: .combine)
                        .accessibilityLabel("\(entry.time.formatted()), \(entry.senderDid) to \(entry.recipientDid), \(entry.messageId), \(entry.ciphertextSize) bytes, \(entry.state)")
                    }
                }.padding(8)
            }
        }.font(TUITheme.monoFont).background(TUITheme.bg)
    }
}
