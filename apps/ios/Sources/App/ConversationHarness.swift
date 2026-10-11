#if DEBUG
import SwiftUI

// Launch-only UI proof with invented peers and mail. No identity, mailbox or saved data.
private let phone = "did:web:phone.example.invalid"
private let alpha = "did:web:sample-project.alpha.pi.ratking-fleet.invalid"
private let gamma = "did:web:other-project.gamma.pi.ratking-fleet.invalid"
struct ConversationHarness: View {
    @State private var store = InboxStore(preview: phone, peers: [alpha, gamma], messages: [
        MailItem(id: alpha + "/3m5abcde23456", message: .map(["senderDid": .string(alpha), "messageId": .string("3m5abcde23456")]), sender: alpha,
            text: #"{"body":"Synthetic status","from":"sample-project/alpha","label":"Sample Alpha"}"#, receipt: "delivered"),
        MailItem(id: phone + "/3m5abcde23457", message: .map(["senderDid": .string(phone), "messageId": .string("3m5abcde23457")]), sender: phone,
            text: "Synthetic reply", receipt: "accepted", replyTo: .map(["senderDid": .string(alpha), "messageId": .string("3m5abcde23456")]), outgoingTo: alpha),
    ])
    @State private var filters = ListFilters()
    var body: some View {
        ConversationsView(store: store, filters: filters)
            .font(TUITheme.monoFont).foregroundStyle(TUITheme.fg).background(TUITheme.bg)
    }
}
#endif
