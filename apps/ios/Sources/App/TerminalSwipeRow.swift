import SwiftUI
import UIKit

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
    let open: () -> Void
    @ViewBuilder let content: () -> Content
    @State private var offset: CGFloat = 0
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
        .overlay {
            TerminalRowGestures(canArchive: canArchive, canSnooze: canSnooze, archive: archive, snooze: snooze, open: open) { value in
                if value == 0 { withAnimation(.easeOut(duration: 0.12)) { offset = 0 } } else { offset = value }
            }
        }
        .accessibilityElement(children: .combine).accessibilityAddTraits(.isButton)
        .accessibilityAction { open() }
        .accessibilityAction(named: Text(archiveLabel)) { if canArchive { archive() } }
        .accessibilityAction(named: Text(snoozeLabel)) { if canSnooze { snooze() } }
    }
}

// UIKit arbitrates the real touch stream. Tap requires pan failure; once pan
// begins, ending or cancelling it can never emit a tap. Its stationary surface
// also keeps translation coordinates independent of the moving row content.
private struct TerminalRowGestures: UIViewRepresentable {
    let canArchive: Bool; let canSnooze: Bool
    let archive: () -> Void; let snooze: () -> Void; let open: () -> Void
    let moved: (CGFloat) -> Void
    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeUIView(context: Context) -> UIView {
        let view = UIView(); view.backgroundColor = .clear; view.isAccessibilityElement = false
        let pan = UIPanGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.pan(_:)))
        pan.maximumNumberOfTouches = 1; pan.delegate = context.coordinator
        let tap = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.tap(_:)))
        tap.require(toFail: pan)
        view.addGestureRecognizer(pan); view.addGestureRecognizer(tap)
        return view
    }
    func updateUIView(_ uiView: UIView, context: Context) { context.coordinator.owner = self }
    @MainActor final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        var owner: TerminalRowGestures
        init(_ owner: TerminalRowGestures) { self.owner = owner }
        func gestureRecognizerShouldBegin(_ gesture: UIGestureRecognizer) -> Bool {
            guard let pan = gesture as? UIPanGestureRecognizer else { return true }
            let velocity = pan.velocity(in: pan.view)
            // Failing vertical pans lets the ancestor scroll view own them.
            return abs(velocity.x) > abs(velocity.y) * 1.5
        }
        @objc func tap(_ gesture: UITapGestureRecognizer) { if gesture.state == .ended { owner.open() } }
        @objc func pan(_ gesture: UIPanGestureRecognizer) {
            let delta = gesture.translation(in: gesture.view)
            switch gesture.state {
            case .began, .changed:
                let permitted = (delta.x < 0 && owner.canArchive) || (delta.x > 0 && owner.canSnooze)
                owner.moved(permitted ? delta.x : 0)
            case .ended:
                owner.moved(0)
                switch TerminalSwipe.action(horizontal: Double(delta.x), vertical: Double(delta.y), width: Double(gesture.view?.bounds.width ?? 320)) {
                case .archive where owner.canArchive: owner.archive()
                case .snooze where owner.canSnooze: owner.snooze()
                default: break
                }
            case .cancelled, .failed: owner.moved(0)
            default: break
            }
        }
    }
}
