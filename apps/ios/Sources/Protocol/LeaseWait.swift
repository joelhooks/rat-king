import Foundation

struct LeaseWait {
    let until: Date
    func remaining(at now: Date) -> Int { max(0, Int(ceil(until.timeIntervalSince(now)))) }
    func message(at now: Date) -> String {
        let seconds = remaining(at: now)
        return String(format: "waiting for previous session (%d:%02d)", seconds / 60, seconds % 60)
    }
}
