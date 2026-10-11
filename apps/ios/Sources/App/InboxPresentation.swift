import Foundation

// loading -> showing -> loading on reconnect; live arrivals are buffered until
// reveal. Existing rows keep their position while status changes remain visible.
struct InboxPresentation<ID: Hashable> {
    enum Phase { case loading, showing }
    private(set) var phase: Phase = .loading
    private(set) var progress = 0
    private(set) var visible: [ID] = []
    private(set) var pending: [ID] = []
    var loading: Bool { phase == .loading }
    mutating func begin() { phase = .loading; progress = 0; visible = []; pending = [] }
    mutating func loaded(_ count: Int) { progress = count }
    mutating func finish(_ ids: [ID]) { visible = ids; pending = []; phase = .showing }
    mutating func update(_ ids: [ID]) {
        guard !loading else { return }
        let retained = Set(ids)
        visible.removeAll { !retained.contains($0) }
        let shown = Set(visible)
        pending = ids.filter { !shown.contains($0) }
    }
    mutating func showLocal(_ id: ID) {
        guard !loading, !visible.contains(id) else { return }
        visible.insert(id, at: 0); pending.removeAll { $0 == id }
    }
    mutating func reveal(_ ids: [ID]) { finish(ids) }
}

// Used by both real details and the touch harness. At the end, return to list.
func nextInboxID<ID: Equatable>(after id: ID, in ids: [ID]) -> ID? {
    guard let index = ids.firstIndex(of: id), index + 1 < ids.count else { return nil }
    return ids[index + 1]
}
