#if DEBUG
import SwiftUI

// Launch-only UI proof with invented peers and mail. No identity, mailbox or saved data.
private let phone = "did:web:phone.example.invalid"
private let alpha = "did:web:sample-project.alpha.pi.ratking-fleet.invalid"
private let gamma = "did:web:other-project.gamma.pi.ratking-fleet.invalid"
private let desk = "did:web:sample-project.desk.pi.ratking-fleet.invalid"
struct ConversationHarness: View {
    @State private var store = InboxStore(preview: phone, peers: [alpha, gamma], messages: [
        MailItem(id: alpha + "/3m5abcde23456", message: .map(["senderDid": .string(alpha), "messageId": .string("3m5abcde23456")]), sender: alpha,
            text: #"{"body":"Synthetic status","from":"sample-project/alpha","label":"Sample Alpha"}"#, receipt: "delivered"),
        MailItem(id: phone + "/3m5abcde23457", message: .map(["senderDid": .string(phone), "messageId": .string("3m5abcde23457")]), sender: phone,
            text: "Synthetic reply", receipt: "accepted", replyTo: .map(["senderDid": .string(alpha), "messageId": .string("3m5abcde23456")]), outgoingTo: alpha),
        MailItem(id: desk + "/3m5abcde23458", message: .map(["senderDid": .string(desk), "messageId": .string("3m5abcde23458")]), sender: desk,
            text: #"{"$type":"sh.mschf.ratking.desk.item","project":"sample-project","itemId":"review","kind":"decision","createdAt":"2025-11-09T00:00:00Z","title":"Review synthetic release","why":"Choose what to do with this sample candidate.","body":"The simulated candidate passed its checks. This is sample data only. Keep the first device on the old build, install the new build on a second device, then compare the visible version in Identity. Do not change the mailbox. Use https://example.invalid/review for the invented receipt.","choices":[{"key":"release","label":"Release choice","suggest":"hold","options":[{"id":"hold","label":"Hold candidate","outcome":"No release changes."},{"id":"accept","label":"Accept candidate","outcome":"Candidate moves to review."}]}],"refs":[]}"#,
            receipt: "delivered"),
    ])
    @State private var filters = ListFilters()
    var body: some View {
        ConversationsView(store: store, filters: filters)
            .font(TUITheme.monoFont).foregroundStyle(TUITheme.fg).background(TUITheme.bg)
    }
}
#endif
