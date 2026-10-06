import CoreGraphics
import CoreText
import SwiftUI
import UIKit

// Runtime font registration so we don't have to fight generated Info.plists.
// We prefer Geist Pixel (Square) when present, but always fall back to a system mono.
@MainActor
enum FontBook {
    private static let geistSquareFilename = "GeistPixel-Square"

    private static var didRegister = false
    private static var pixelPostScriptName: String?

    static func registerFontsIfNeeded() {
        guard !didRegister else { return }
        didRegister = true

        // If it is already registered, capture the name and bail.
        let candidates = [
            "GeistPixel-Square",
            "GeistPixelSquare",
            "GeistPixel-Square-Regular",
            "GeistPixelSquare-Regular",
        ]
        for c in candidates where UIFont(name: c, size: 12) != nil {
            pixelPostScriptName = c
            return
        }

        guard let url = bundledFontURL(named: geistSquareFilename) else { return }

        var error: Unmanaged<CFError>?
        _ = CTFontManagerRegisterFontsForURL(url as CFURL, .process, &error)

        // Derive the actual PostScript name from the font data so callers can use Font.custom(name:size:).
        if let ps = fontPostScriptName(from: url) {
            pixelPostScriptName = ps
        }
    }

    static func pixelFont(size: CGFloat) -> Font {
        registerFontsIfNeeded()
        if let name = pixelPostScriptName {
            return Font.custom(name, size: size)
        }
        return Font.system(size: size, weight: .regular, design: .monospaced)
    }

    static func pixelFontBold(size: CGFloat) -> Font {
        // Geist Pixel doesn't really do weights; keep the bold "feel" via size/contrast elsewhere.
        registerFontsIfNeeded()
        if let name = pixelPostScriptName {
            return Font.custom(name, size: size)
        }
        return Font.system(size: size, weight: .semibold, design: .monospaced)
    }

    private static func bundledFontURL(named base: String) -> URL? {
        // We include both `.ttf` + `.otf` in repo while iterating; prefer ttf.
        if let ttf = Bundle.main.url(forResource: base, withExtension: "ttf") { return ttf }
        if let otf = Bundle.main.url(forResource: base, withExtension: "otf") { return otf }

        // If Xcode copies with subdirs, search the bundle.
        let urls = (Bundle.main.urls(forResourcesWithExtension: "ttf", subdirectory: nil) ?? [])
            + (Bundle.main.urls(forResourcesWithExtension: "otf", subdirectory: nil) ?? [])
        return urls.first { $0.lastPathComponent == "\(base).ttf" || $0.lastPathComponent == "\(base).otf" }
    }

    private static func fontPostScriptName(from url: URL) -> String? {
        guard
            let provider = CGDataProvider(url: url as CFURL),
            let cgFont = CGFont(provider),
            let ps = cgFont.postScriptName as String?
        else { return nil }
        return ps
    }
}
