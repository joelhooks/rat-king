import SwiftUI

struct InboxHistoryScroll {
    private var atEnd = false
    private var approached = false

    mutating func appear(load: () -> Void) {
        atEnd = true
        if approached { approached = false; load() }
    }

    mutating func disappear() { atEnd = false }

    mutating func drag(_ value: DragGesture.Value, load: () -> Void) {
        guard value.translation.height < -12, abs(value.translation.height) > abs(value.translation.width) else { return }
        if atEnd { approached = false; load() }
        else { approached = true }
    }
}

struct InboxHistoryFooter: View {
    let store: InboxStore
    @Binding var scroll: InboxHistoryScroll

    var body: some View {
        if store.hasOlder {
            Button(store.loadingOlder ? "[LOADING EARLIER MAIL…]" : "[LOAD EARLIER MAIL]") { store.loadOlder() }
                .disabled(store.loadingOlder || store.state != .live)
                .foregroundStyle(TUITheme.accent)
                .accessibilityIdentifier("inbox-load-older")
                .onAppear { scroll.appear(load: store.loadOlder) }
                .onDisappear { scroll.disappear() }
        }
    }
}
