import Foundation

// Public contract: decode iai-meter.portfolio.v1, never recompute totals, nil shows "확인 안 됨".

/// Nonnegative USD decimal string: ASCII digits, 1...92 integer digits, exactly 6 decimals. Never converted to floating point.
struct USDAmount: Decodable, Equatable {
    let raw: String
    init?(_ s: String) {
        let parts = s.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 2, parts[1].utf8.count == 6, (1...92).contains(parts[0].utf8.count),
              s.utf8.allSatisfy({ $0 == 46 || (48...57).contains($0) }) else { return nil }
        raw = s
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        let s = try c.decode(String.self) // JSON numbers fail here by design
        guard let v = USDAmount(s) else {
            throw DecodingError.dataCorruptedError(in: c, debugDescription: "invalid amount")
        }
        self = v
    }
    /// Compact: truncated to 2 decimals. Full: all 6 decimals.
    func formatted(full: Bool = false) -> String {
        let p = raw.split(separator: ".")
        var intPart = String(p[0].drop(while: { $0 == "0" }))
        if intPart.isEmpty { intPart = "0" }
        var grouped = ""
        for (i, ch) in intPart.reversed().enumerated() {
            if i > 0 && i % 3 == 0 { grouped.append(",") }
            grouped.append(ch)
        }
        return "$" + String(grouped.reversed()) + "." + String(p[1].prefix(full ? 6 : 2))
    }
}

struct Balance: Decodable { let reportedCreditUsd: USDAmount?; let conservativeAvailableUsd: USDAmount? }
/// Portfolio totals. Usage fields are optional and lenient: missing or malformed values decode as nil (unknown), never 0.
struct Totals: Decodable {
    let reportedCreditUsd: USDAmount?, conservativeAvailableUsd: USDAmount?
    let costUsd: USDAmount?
    /// Raw request count string; validated by MeterViewModel.digits.
    let requests: String?
    private enum K: String, CodingKey { case reportedCreditUsd, conservativeAvailableUsd, costUsd, requests }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        reportedCreditUsd = try c.decodeIfPresent(USDAmount.self, forKey: .reportedCreditUsd)
        conservativeAvailableUsd = try c.decodeIfPresent(USDAmount.self, forKey: .conservativeAvailableUsd)
        costUsd = try? c.decodeIfPresent(USDAmount.self, forKey: .costUsd)
        requests = try? c.decodeIfPresent(String.self, forKey: .requests)
    }
}
struct SourceError: Decodable { let source: String? }
struct Snapshot: Decodable {
    let state: String; let balanceObservedAt: String?; let creditDayUtc: String?
    let resetsAt: String?; let balance: Balance?; let errors: [SourceError]?
}
struct Account: Decodable { let id: String; let label: String; let balanceIncluded: Bool; let snapshot: Snapshot }

struct Portfolio: Decodable {
    let state: String, generatedAt: String, creditDayUtc: String, resetsAt: String
    let accountCount: Int, balanceAccountCount: Int
    let totals: Totals
    /// Accounts whose current-day usage is aggregated; nil when absent (old payloads).
    let usageAccountCount: Int?
    let accounts: [Account]
    static let schemaID = "iai-meter.portfolio.v1"
    /// States considered displayable. Any other aggregate or included snapshot state, including error/stale/unconfigured, marks the portfolio stale.
    static let freshStates: Set<String> = ["ready", "partial", "demo"]
    /// Demo data may be displayed but must be labeled explicitly.
    var isDemo: Bool { state == "demo" || accounts.contains { $0.balanceIncluded && $0.snapshot.state == "demo" } }
    private enum K: String, CodingKey {
        case schema, state, generatedAt, creditDayUtc, resetsAt, accountCount, balanceAccountCount, totals, accounts, usageAccountCount
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        func bad(_ m: String) -> Error { DecodingError.dataCorruptedError(forKey: .accounts, in: c, debugDescription: m) }
        guard try c.decode(String.self, forKey: .schema) == Self.schemaID else { throw bad("schema") }
        state = try c.decode(String.self, forKey: .state)
        generatedAt = try c.decode(String.self, forKey: .generatedAt)
        creditDayUtc = try c.decode(String.self, forKey: .creditDayUtc)
        resetsAt = try c.decode(String.self, forKey: .resetsAt)
        accountCount = try c.decode(Int.self, forKey: .accountCount)
        balanceAccountCount = try c.decode(Int.self, forKey: .balanceAccountCount)
        totals = try c.decode(Totals.self, forKey: .totals)
        usageAccountCount = try? c.decodeIfPresent(Int.self, forKey: .usageAccountCount)
        accounts = try c.decode([Account].self, forKey: .accounts)
        guard accounts.count <= 100, accountCount == accounts.count,
              balanceAccountCount == accounts.filter(\.balanceIncluded).count else { throw bad("counts") }
    }

    /// Stale if aggregate or any included source is old, future, wrong day, or errored.
    func isStale(now: Date) -> Bool {
        func badTime(_ s: String?) -> Bool {
            guard let s, let d = TimeUtil.parse(s) else { return true }
            let age = now.timeIntervalSince(d)
            return age > 180 || age < -30
        }
        if !Self.freshStates.contains(state) || badTime(generatedAt)
            || creditDayUtc != TimeUtil.utcDay(now) { return true }
        return accounts.filter(\.balanceIncluded).contains { a in
            badTime(a.snapshot.balanceObservedAt) || a.snapshot.creditDayUtc != creditDayUtc
                || !Self.freshStates.contains(a.snapshot.state)
                || (a.snapshot.errors ?? []).contains { $0.source == "balance" || $0.source == "account" }
        }
    }
}

enum TimeUtil {
    /// ISO8601 with or without fractional seconds.
    static func parse(_ s: String) -> Date? {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: s) { return d }
        f.formatOptions = [.withInternetDateTime]
        return f.date(from: s)
    }
    /// Current UTC date as yyyy-MM-dd.
    static func utcDay(_ now: Date) -> String {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "UTC")!
        let c = cal.dateComponents([.year, .month, .day], from: now)
        return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
    }
}

/// Display helpers for menu and floating panel. Inject `now` for testability.
struct MeterViewModel {
    let portfolio: Portfolio?
    let now: Date
    static let unknown = "확인 안 됨"
    var stale: Bool { portfolio?.isStale(now: now) ?? true }
    private var amount: USDAmount? {
        guard let p = portfolio, p.balanceAccountCount > 0 else { return nil }
        return p.totals.conservativeAvailableUsd
    }
    var isDemo: Bool { portfolio?.isDemo ?? false }
    var title: String {
        let demo = isDemo ? "DEMO 데모 " : ""
        guard let a = amount else { return demo + Self.unknown }
        return demo + (stale ? a.formatted() + " (오래됨)" : a.formatted())
    }
    var balanceText: String { amount?.formatted(full: true) ?? Self.unknown }
    var coverageText: String {
        guard let p = portfolio, p.balanceAccountCount > 0 else { return "반영 계정 " + Self.unknown }
        return "반영 계정 \(p.balanceAccountCount)/\(p.accountCount)"
    }
    /// Usage is shown only for fresh current-day portfolios with valid usage coverage.
    private var usage: (p: Portfolio, partial: Bool)? {
        guard let p = portfolio, !stale, let u = p.usageAccountCount, u > 0, u <= p.accountCount else { return nil }
        return (p, u < p.accountCount)
    }
    private func tag(_ s: String) -> String { (usage?.partial ?? false) ? s + " (일부)" : s }
    /// Strict ASCII digit string (no sign, decimal, exponent), leading zeros stripped.
    static func digits(_ s: String?) -> String? {
        guard let s, !s.isEmpty, s.utf8.count <= 40, s.utf8.allSatisfy({ (48...57).contains($0) }) else { return nil }
        let t = String(s.drop(while: { $0 == "0" }))
        return t.isEmpty ? "0" : t
    }
    private var requestDigits: String? { usage.flatMap { Self.digits($0.p.totals.requests) } }
    var usageCostText: String {
        guard let u = usage, let c = u.p.totals.costUsd else { return Self.unknown }
        return tag(c.formatted(full: true))
    }
    var requestCountText: String { requestDigits.map { tag($0 + "회") } ?? Self.unknown }
    /// Mean cost per recorded Router request, truncated to 6 decimals using Int64 microUSD.
    var averageRequestCostText: String {
        guard let u = usage, let d = requestDigits, let n = Int64(d) else { return Self.unknown }
        if n == 0 { return tag("요청 없음") }
        guard let c = u.p.totals.costUsd else { return Self.unknown }
        let parts = c.raw.split(separator: ".")
        guard let micro = Int64(String(parts[0]) + String(parts[1])) else { return Self.unknown }
        let avg = micro / n
        let frac = String(avg % 1_000_000)
        let pad = String(repeating: "0", count: 6 - frac.count) + frac
        return USDAmount("\(avg / 1_000_000).\(pad)").map { tag($0.formatted(full: true)) } ?? Self.unknown
    }
    var usageCoverageText: String {
        guard let p = portfolio, !stale, let u = p.usageAccountCount, u >= 0, u <= p.accountCount else {
            return "사용량 반영 계정 " + Self.unknown
        }
        return "사용량 반영 \(u)/\(p.accountCount)" + (u < p.accountCount ? " (일부)" : "")
    }
    var resetText: String {
        guard let s = portfolio?.resetsAt, let d = TimeUtil.parse(s) else { return "초기화 " + Self.unknown }
        let t = d.timeIntervalSince(now)
        guard t.isFinite, t > -8 * 86400, t < 8 * 86400 else { return "초기화 " + Self.unknown }
        if t <= 0 { return "초기화 지남 · 재조회 대기" }
        let sec = Int(t)
        return "초기화까지 \(sec / 3600)시간 \((sec % 3600) / 60)분"
    }
}
