import Foundation
import SwiftUI

func messageHTTPSLinks(_ text: String) -> [URL] {
    guard text.range(of: "https://", options: .caseInsensitive) != nil,
          let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue) else { return [] }
    var seen = Set<URL>()
    return detector.matches(in: text, range: NSRange(text.startIndex..., in: text)).compactMap { match in
        guard let range = Range(match.range, in: text), text[range].prefix(8).lowercased() == "https://",
              let url = match.url, url.scheme?.lowercased() == "https", let host = url.host(), !host.isEmpty,
              url.user() == nil, url.password() == nil, seen.insert(url).inserted else { return nil }
        return url
    }
}

struct MessageLinks: View {
    let text: String

    var body: some View {
        let links = messageHTTPSLinks(text)
        if !links.isEmpty {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(links, id: \.self) { url in
                    Link(destination: url) {
                        HStack(spacing: 6) {
                            Image(systemName: "arrow.up.right")
                            Text(url.absoluteString).lineLimit(1).truncationMode(.tail)
                        }
                        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                        .contentShape(Rectangle())
                    }
                    .foregroundStyle(TUITheme.accent)
                    .accessibilityLabel("Open " + url.absoluteString)
                }
            }.font(TUITheme.monoFont)
        }
    }
}
