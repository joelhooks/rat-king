import Foundation
import CoreFoundation

// JSON $bytes and canonical DRISL-CBOR bytes are separate surfaces.
indirect enum Value: Equatable, Sendable {
    case map([String: Value]), array([Value]), string(String), bytes(Data), int(Int64), bool(Bool), null
    subscript(_ key: String) -> Value? { if case let .map(m) = self { return m[key] }; return nil }
    var text: String { get throws { guard case let .string(s) = self else { throw ProtocolError.invalid("Expected string") }; return s } }
    var data: Data { get throws { guard case let .bytes(d) = self else { throw ProtocolError.invalid("Expected bytes") }; return d } }
    var number: Int64 { get throws { guard case let .int(n) = self else { throw ProtocolError.invalid("Expected integer") }; return n } }
    func required(_ key: String) throws -> Value { guard let v = self[key] else { throw ProtocolError.invalid("Missing \(key)") }; return v }
    func object() throws -> [String: Value] { guard case let .map(m) = self else { throw ProtocolError.invalid("Expected object") }; return m }
    func list() throws -> [Value] { guard case let .array(a) = self else { throw ProtocolError.invalid("Expected array") }; return a }
    static func json(_ data: Data) throws -> Value { try fromJSON(JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])) }
    private static func fromJSON(_ value: Any) throws -> Value {
        switch value {
        case let m as [String: Any]:
            if m.count == 1, let s = m["$bytes"] as? String { guard let d = Data(base64Encoded: s) else { throw ProtocolError.invalid("Invalid bytes") }; return .bytes(d) }
            return .map(try m.mapValues(fromJSON))
        case let a as [Any]: return .array(try a.map(fromJSON))
        case let s as String: return .string(s)
        case let n as NSNumber:
            if CFGetTypeID(n) == CFBooleanGetTypeID() { return .bool(n.boolValue) }
            guard n.doubleValue.isFinite, n.doubleValue.rounded() == n.doubleValue, abs(n.doubleValue) <= 9_007_199_254_740_991 else { throw ProtocolError.invalid("Unsupported number") }; return .int(n.int64Value)
        case is NSNull: return .null
        default: throw ProtocolError.invalid("Invalid JSON")
        }
    }
    var jsonObject: Any {
        switch self {
        case let .map(m): return m.mapValues(\.jsonObject)
        case let .array(a): return a.map(\.jsonObject)
        case let .string(s): return s
        case let .bytes(d): return ["$bytes": d.base64EncodedString()]
        case let .int(n): return n
        case let .bool(b): return b
        case .null: return NSNull()
        }
    }
    func jsonData() throws -> Data { try JSONSerialization.data(withJSONObject: jsonObject, options: [.sortedKeys, .fragmentsAllowed]) }
}
enum ProtocolError: Error, LocalizedError {
    case invalid(String)
    var errorDescription: String? { switch self { case let .invalid(s): return s } }
}
enum CBOR {
    static func encode(_ v: Value) -> Data {
        switch v {
        case let .int(n): return n >= 0 ? head(0, UInt64(n)) : head(1, UInt64(-(n + 1)))
        case let .bytes(d): return head(2, UInt64(d.count)) + d
        case let .string(s): let d = Data(s.utf8); return head(3, UInt64(d.count)) + d
        case let .array(a): return a.reduce(head(4, UInt64(a.count))) { $0 + encode($1) }
        case let .map(m):
            let pairs = m.map { (encode(.string($0.key)), encode($0.value)) }.sorted { $0.0.count == $1.0.count ? $0.0.lexicographicallyPrecedes($1.0) : $0.0.count < $1.0.count }
            return pairs.reduce(head(5, UInt64(m.count))) { $0 + $1.0 + $1.1 }
        case let .bool(b): return Data([b ? 0xf5 : 0xf4])
        case .null: return Data([0xf6])
        }
    }
    private static func head(_ major: UInt8, _ n: UInt64) -> Data {
        if n < 24 { return Data([major << 5 | UInt8(n)]) }
        let count = n <= 255 ? 1 : n <= 65535 ? 2 : n <= UInt32.max ? 4 : 8
        let ai: UInt8 = count == 1 ? 24 : count == 2 ? 25 : count == 4 ? 26 : 27
        return Data([major << 5 | ai] + (0..<count).reversed().map { UInt8(truncatingIfNeeded: n >> ($0 * 8)) })
    }
    static func decode(_ d: Data) throws -> Value {
        guard d.count <= 2_000_000 else { throw ProtocolError.invalid("CBOR too large") }
        var reader = Reader(bytes: Array(d)); let v = try reader.value(depth: 0)
        guard reader.offset == d.count, encode(v) == d else { throw ProtocolError.invalid("Noncanonical CBOR") }; return v
    }
    private struct Reader {
        let bytes: [UInt8]; var offset = 0
        mutating func take(_ n: Int) throws -> [UInt8] {
            guard n >= 0, n <= bytes.count - offset else { throw ProtocolError.invalid("Truncated CBOR") }
            defer { offset += n }; return Array(bytes[offset..<offset+n])
        }
        mutating func value(depth: Int) throws -> Value {
            guard depth < 64 else { throw ProtocolError.invalid("CBOR depth") }
            let first = try take(1)[0], major = first >> 5, ai = first & 31
            if major == 7 { switch ai { case 20: return .bool(false); case 21: return .bool(true); case 22: return .null; default: throw ProtocolError.invalid("Unsupported CBOR scalar") } }
            let n: UInt64
            if ai < 24 { n = UInt64(ai) } else {
                guard (24...27).contains(ai) else { throw ProtocolError.invalid("Indefinite CBOR") }
                n = try take(1 << Int(ai - 24)).reduce(0) { $0 << 8 | UInt64($1) }
            }
            guard n <= 9_007_199_254_740_991 else { throw ProtocolError.invalid("Unsafe integer") }
            switch major {
            case 0: return .int(Int64(n))
            case 1: return .int(-1 - Int64(n))
            case 2: return .bytes(Data(try take(Int(n))))
            case 3: guard let s = String(bytes: try take(Int(n)), encoding: .utf8) else { throw ProtocolError.invalid("Invalid UTF8") }; return .string(s)
            case 4:
                guard n <= UInt64(bytes.count - offset) else { throw ProtocolError.invalid("Array too large") }; return .array(try (0..<Int(n)).map { _ in try value(depth: depth+1) })
            case 5:
                guard n <= UInt64((bytes.count-offset)/2) else { throw ProtocolError.invalid("Map too large") }
                var m: [String: Value] = [:]
                for _ in 0..<Int(n) { let k = try value(depth: depth+1).text; guard m[k] == nil else { throw ProtocolError.invalid("Duplicate key") }; m[k] = try value(depth: depth+1) }; return .map(m)
            default: throw ProtocolError.invalid("Unsupported CBOR type")
            }
        }
    }
}
extension Data {
    var base64url: String { base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") }
    init(base64url: String) throws {
        let s = base64url.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        guard let d = Data(base64Encoded: s + String(repeating: "=", count: (4-s.count%4)%4)) else { throw ProtocolError.invalid("Invalid base64url") }; self = d
    }
}
