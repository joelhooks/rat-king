import XCTest

final class InboxBenchmarkTests: XCTestCase {
    @MainActor func testColdOpenWithFiveHundredMessages() throws {
        let app = XCUIApplication()
        for (mode, expected) in [("legacy", 500), ("paged", 50)] {
            var samples: [Double] = []
            for _ in 0..<3 {
                app.launchArguments = ["--inbox-benchmark", "--\(mode)"]
                app.launch()
                let result = app.staticTexts["inbox-benchmark-result"]
                XCTAssertTrue(result.waitForExistence(timeout: 10), app.staticTexts["inbox-benchmark-error"].exists ? app.staticTexts["inbox-benchmark-error"].label : "First conversation did not appear")
                let numbers = result.label.split(separator: " ")
                XCTAssertEqual(numbers.first.flatMap { Int($0) }, expected)
                samples.append(try XCTUnwrap(numbers.last.flatMap { Double($0) }))
                app.terminate()
            }
            print("INBOX_BENCHMARK \(mode) fetched=\(expected) first_row_ms=\(samples) median_ms=\(samples.sorted()[1])")
        }
    }
}
