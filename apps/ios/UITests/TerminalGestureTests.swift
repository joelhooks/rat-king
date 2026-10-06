import XCTest

final class TerminalGestureTests: XCTestCase {
    @MainActor private func launch(resolved: Bool = false) -> XCUIApplication {
        let app = XCUIApplication(); app.launchArguments = ["--terminal-gesture-test"] + (resolved ? ["--resolved"] : [])
        app.launch(); return app
    }
    @MainActor private func row(_ app: XCUIApplication) -> XCUIElement {
        let row = app.descendants(matching: .any).matching(identifier: "gesture-row").firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 5)); return row
    }
    @MainActor private func counts(_ app: XCUIApplication, _ text: String) {
        let element = app.staticTexts["gesture-counts"]
        let expected = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label == %@", text), object: element)
        XCTAssertEqual(XCTWaiter.wait(for: [expected], timeout: 5), .completed)
        XCTAssertFalse(app.staticTexts["gesture-destination"].exists)
    }
    @MainActor func testFullLeftSwipeArchivesOpenAndResolvedRowsWithoutOpening() {
        for resolved in [false, true] {
            for start in [0.85, 0.95] {
                let app = launch(resolved: resolved), element = row(app)
                element.coordinate(withNormalizedOffset: CGVector(dx: start, dy: 0.5)).press(forDuration: 0.05, thenDragTo: element.coordinate(withNormalizedOffset: CGVector(dx: 0.08, dy: 0.5)))
                counts(app, "open=0 archive=1 snooze=0")
                // A second drag over the disabled archived row is still not a tap.
                let archived = row(app)
                archived.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5)).press(forDuration: 0.05, thenDragTo: archived.coordinate(withNormalizedOffset: CGVector(dx: 0.08, dy: 0.5)))
                counts(app, "open=0 archive=1 snooze=0")
                app.terminate()
            }
        }
    }
    @MainActor func testFullRightAndShortHorizontalSwipesNeverOpen() {
        for end in [0.3, 0.92] {
            let app = launch(), element = row(app)
            element.coordinate(withNormalizedOffset: CGVector(dx: 0.08, dy: 0.5)).press(forDuration: 0.05, thenDragTo: element.coordinate(withNormalizedOffset: CGVector(dx: end, dy: 0.5)))
            counts(app, end < 0.5 ? "open=0 archive=0 snooze=0" : "open=0 archive=0 snooze=1")
            app.terminate()
        }
    }
    @MainActor func testTapStillNavigates() {
        let app = launch(); row(app).tap()
        XCTAssertTrue(app.staticTexts["gesture-destination"].waitForExistence(timeout: 5)); app.terminate()
    }
    @MainActor func testVerticalDragScrollsWithoutOpeningOrArchiving() {
        let app = launch(), element = row(app)
        let before = app.staticTexts["scroll-4"].frame.minY
        let start = element.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: 0, dy: 250)))
        counts(app, "open=0 archive=0 snooze=0")
        // Now scroll upwards through the same stationary row surface.
        let current = row(app).coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.7))
        current.press(forDuration: 0.05, thenDragTo: current.withOffset(CGVector(dx: 0, dy: -60)))
        XCTAssertLessThan(app.staticTexts["scroll-4"].frame.minY, before)
        counts(app, "open=0 archive=0 snooze=0"); app.terminate()
    }
}
