import SwiftUI
import UIKit
import XCTest
@testable import RatKing

final class ThemeTests: XCTestCase {
    // UIKit and SwiftUI resolve dynamic colours on render threads, not only the main thread. The provider closures
    // must not be main-actor isolated, or Swift 6's runtime isolation check traps when they run there.
    @MainActor
    func testThemeColoursResolveOffTheMainThread() async {
        let colours = [TUITheme.bg, TUITheme.panel, TUITheme.fg, TUITheme.accent, TUITheme.warn].map { UIColor($0) }
        let resolved = await Task.detached {
            colours.flatMap { colour in
                [UIUserInterfaceStyle.dark, .light].map { style in
                    colour.resolvedColor(with: UITraitCollection(userInterfaceStyle: style)).cgColor.components ?? []
                }
            }
        }.value
        XCTAssertEqual(resolved.count, colours.count * 2)
        XCTAssertNotEqual(resolved[0], resolved[1], "dark and light differ")
    }
}
