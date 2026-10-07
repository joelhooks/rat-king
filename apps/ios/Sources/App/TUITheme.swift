import SwiftUI
import UIKit

@MainActor
enum TUITheme {
    // Palette Deck: coordinated semantic roles in Pi dark and light presets.
    private static func colour(_ dark: UInt32, _ light: UInt32) -> Color {
        Color(uiColor: UIColor { traits in
            let hex = traits.userInterfaceStyle == .dark ? dark : light
            return UIColor(red: CGFloat((hex >> 16) & 255) / 255, green: CGFloat((hex >> 8) & 255) / 255, blue: CGFloat(hex & 255) / 255, alpha: 1)
        })
    }
    static let bg = colour(0x18181b, 0xfafafa)
    static let panel = colour(0x202024, 0xf0f0f2)
    static let fg = colour(0xe4e4e7, 0x27272a)
    static let dim = colour(0xa1a1aa, 0x52525b)
    static let grid = colour(0x52525b, 0xa1a1aa)
    static let accent = colour(0xc4a7e7, 0x6d28d9)
    static let ok = colour(0xa6da95, 0x287034)
    static let warn = colour(0xeed49f, 0x855400)
    static let err = colour(0xed8796, 0xb42338)
    static let info = colour(0x8aadf4, 0x235fa4)
    static let teal = colour(0x8bd5ca, 0x146b65)
    static let purple = accent

    // Retain the pixel font, including the production swipe row.
    static var monoFont: Font { FontBook.pixelFont(size: 11) }
    static var monoFontBold: Font { FontBook.pixelFontBold(size: 11) }
    static var titleFont: Font { FontBook.pixelFontBold(size: 13) }
    static var microFont: Font { FontBook.pixelFont(size: 10) }
    static var microFontBold: Font { FontBook.pixelFontBold(size: 10) }
    static func receipt(_ state: String) -> Color {
        switch state {
        case "failed", "expired": err
        case "acked", "delivered": ok
        case "queued": warn
        default: accent
        }
    }
}

struct ThinDivider: View {
    var body: some View { Rectangle().fill(TUITheme.grid).frame(height: 1) }
}

// Shared Shell: framing owns no dialog or message state.
struct TerminalPanel<Content: View>: View {
    let title: String
    @ViewBuilder let content: () -> Content
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Text("─ " + title).font(TUITheme.microFontBold).foregroundStyle(TUITheme.accent).lineLimit(1)
                ThinDivider()
            }
            content()
        }.frame(maxWidth: .infinity, alignment: .leading).padding(12)
            .background(TUITheme.panel).overlay(Rectangle().stroke(TUITheme.grid, lineWidth: 1))
    }
}

struct TerminalHints: View {
    let text: String
    var body: some View {
        Text(text).font(TUITheme.microFont).foregroundStyle(TUITheme.dim)
            .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 12).padding(.vertical, 8)
    }
}

// Message Fold: body remains available without filling every transcript row.
struct TerminalMessage: View {
    let text: String
    @State private var expanded = false
    private var lines: Int { text.components(separatedBy: .newlines).count }
    private var folds: Bool { lines > 4 || text.count > 240 }
    var body: some View {
        TerminalPanel(title: "MESSAGE") {
            Text(text).lineLimit(expanded || !folds ? nil : 4).textSelection(.enabled)
            if folds {
                Button(expanded ? "[− collapse]" : "[+ full message · \(lines) lines]") { expanded.toggle() }
                    .foregroundStyle(TUITheme.accent)
            }
        }
    }
}
