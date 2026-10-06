import SwiftUI

// A finite idle/dragging gesture projection; the end event returns to idle and
// emits at most one action. Vertical drags remain the scroll view's business.
enum TerminalSwipe: Equatable {
    case archive, snooze
    static func action(horizontal: Double, vertical: Double, width: Double) -> TerminalSwipe? {
        guard abs(horizontal) > abs(vertical) * 1.5, abs(horizontal) >= max(72, width * 0.55) else { return nil }
        return horizontal < 0 ? .archive : .snooze
    }
}
struct TerminalSwipeRow<Content: View>: View {
    let archiveLabel: String
    let snoozeLabel: String
    let canArchive: Bool
    let canSnooze: Bool
    let archive: () -> Void
    let snooze: () -> Void
    @ViewBuilder let content: () -> Content
    @State private var offset: CGFloat = 0
    @State private var width: CGFloat = 320
    var body: some View {
        ZStack {
            HStack {
                if offset > 0 { Text(snoozeLabel).foregroundStyle(TUITheme.warn) }
                Spacer()
                if offset < 0 { Text(archiveLabel).foregroundStyle(TUITheme.accent) }
            }.font(TUITheme.monoFontBold).padding(.horizontal, 10)
            content().padding(.vertical, 6).padding(.horizontal, 8).frame(maxWidth: .infinity, alignment: .leading)
                .background(TUITheme.panel).offset(x: offset)
        }.background(TUITheme.bg).clipped()
        .background(GeometryReader { geometry in
            Color.clear.onAppear { width = geometry.size.width }.onChange(of: geometry.size.width) { _, value in width = value }
        })
        .simultaneousGesture(DragGesture(minimumDistance: 16).onChanged { gesture in
            let x = gesture.translation.width, y = gesture.translation.height
            guard abs(x) > abs(y) * 1.5 else { return }
            if (x < 0 && canArchive) || (x > 0 && canSnooze) { offset = x }
        }.onEnded { gesture in
            let action = TerminalSwipe.action(horizontal: Double(gesture.translation.width), vertical: Double(gesture.translation.height), width: Double(width))
            withAnimation(.easeOut(duration: 0.12)) { offset = 0 }
            switch action {
            case .archive where canArchive: archive()
            case .snooze where canSnooze: snooze()
            default: break
            }
        })
        .accessibilityAction(named: Text(archiveLabel)) { if canArchive { archive() } }
        .accessibilityAction(named: Text(snoozeLabel)) { if canSnooze { snooze() } }
    }
}
