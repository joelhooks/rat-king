import SwiftUI

@MainActor
enum TUITheme {
    static let bg = Color(red: 0.04, green: 0.06, blue: 0.08)        // near-black
    static let panel = Color(red: 0.06, green: 0.08, blue: 0.11)     // slightly raised
    static let fg = Color(red: 0.92, green: 0.94, blue: 0.97)        // off-white
    static let dim = Color(red: 0.60, green: 0.65, blue: 0.70)       // gray
    static let grid = Color(red: 0.20, green: 0.24, blue: 0.28)      // divider

    static let accent = Color(red: 0.22, green: 0.78, blue: 0.33)    // green
    static let ok = Color(red: 0.22, green: 0.78, blue: 0.33)
    static let warn = Color(red: 0.91, green: 0.63, blue: 0.13)      // amber
    static let err = Color(red: 0.96, green: 0.33, blue: 0.31)       // red
    static let info = Color(red: 0.35, green: 0.67, blue: 0.98)      // blue
    static let teal = Color(red: 0.20, green: 0.79, blue: 0.78)
    static let purple = Color(red: 0.72, green: 0.48, blue: 0.92)

    // Smaller fonts: this is a log viewer, not a brochure.
    static var monoFont: Font { FontBook.pixelFont(size: 9) }
    static var monoFontBold: Font { FontBook.pixelFontBold(size: 9) }
    static var titleFont: Font { FontBook.pixelFontBold(size: 11) }

    // Footer/header micro text.
    static var microFont: Font { FontBook.pixelFont(size: 8) }
    static var microFontBold: Font { FontBook.pixelFontBold(size: 8) }
}

struct ThinDivider: View {
    var body: some View {
        Rectangle()
            .fill(TUITheme.grid.opacity(0.35))
            .frame(height: 1)
    }
}

