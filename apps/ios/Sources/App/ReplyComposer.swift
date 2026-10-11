import SwiftUI

struct ReplyComposer: View {
    let store: InboxStore
    let target: MailItem
    @State private var text = ""
    @State private var summary = ""
    var body: some View {
        TerminalPanel(title: "REPLY / SIGNED PLAINTEXT") {
            Text("TO " + target.sender).foregroundStyle(TUITheme.dim)
            SummaryField(summary: $summary, message: text)
            TextEditor(text: $text).font(TUITheme.monoFont).scrollContentBackground(.hidden).frame(minHeight: 64).background(TUITheme.panel)
            Text("Signed by this phone. Not encrypted.").foregroundStyle(TUITheme.warn).font(TUITheme.microFont)
            Button(store.hasPendingSend ? "[RETRY PENDING SEND]" : "[SIGN + SEND REPLY]") {
                Task {
                    if store.hasPendingSend { await store.send(to: "", text: "") }
                    else { await store.reply(to: target, text: text, summary: summary) }
                    if !store.hasPendingSend, store.lastError == nil { text = ""; summary = "" }
                }
            }.disabled(store.state != .live || store.sending || (!store.hasPendingSend && text.isEmpty)).foregroundStyle(TUITheme.accent)
            if store.hasPendingSend { Text("Saved send pending. Retry uses the same envelope, not this draft.").foregroundStyle(TUITheme.warn) }
            if let status = store.lastSend { Text("LAST SEND: " + status.uppercased()).foregroundStyle(TUITheme.ok) }
            if let error = store.lastError { Text("! " + error).foregroundStyle(TUITheme.err) }
        }.onDisappear { text = ""; summary = "" }
    }
}
