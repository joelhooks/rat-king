import XCTest
@testable import RatKing

final class MessageLinksTests: XCTestCase {
    func testOnlyExplicitHTTPSLinksInFirstAppearanceOrder() {
        for run in 0..<128 {
            let first = "https://example.invalid/a-\(run)?q=1&view=full#reply"
            let second = "https://example.invalid/b-\(run)"
            let urls = run.isMultiple(of: 2) ? [first, second] : [second, first]
            let text = "🧪 (\(urls[0])), example.invalid, http://example.invalid/insecure, ftp://example.invalid/file. \(urls[1]). \(urls[0])"
            XCTAssertEqual(messageHTTPSLinks(text).map(\.absoluteString), urls)
        }
    }

    func testRejectsCredentialsInHTTPSLinks() throws {
        for run in 0..<128 {
            var components = URLComponents()
            components.scheme = "https"
            components.host = "example.invalid"
            components.user = "sample-\(run)"
            components.password = "invented"
            components.path = "/path"
            XCTAssertEqual(messageHTTPSLinks("No action for \(try XCTUnwrap(components.string))"), [])
        }
    }
}
