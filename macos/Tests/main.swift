import Foundation

var passed = 0
func check(_ ok: Bool, _ name: String) {
    guard ok else { print("FAIL: \(name)"); exit(1) }
    passed += 1
}

let big = USDAmount("9007199254740993.999999")
check(big?.formatted(full: true) == "$9,007,199,254,740,993.999999", "full format")
check(big?.formatted() == "$9,007,199,254,740,993.99", "compact format")
check(USDAmount("-1.00") == nil, "negative invalid")
check(USDAmount("1e5") == nil, "exponent invalid")
check((try? JSONDecoder().decode([USDAmount].self, from: Data("[1.5]".utf8))) == nil, "JSON number rejected")
check(MeterViewModel(portfolio: nil, now: Date()).balanceText == "확인 안 됨", "nil balance text")
let before = TimeUtil.parse("2024-01-01T23:59:59Z")
let at = TimeUtil.parse("2024-01-02T00:00:00Z")
check(before.map(TimeUtil.utcDay) == "2024-01-01", "UTC day before midnight")
check(at.map(TimeUtil.utcDay) == "2024-01-02", "UTC day at midnight")

func usageVM(_ extra: String, usage: String = "", n: Int = 1, offset: TimeInterval = 0) -> MeterViewModel {
    let base = Date()
    let g = ISO8601DateFormatter().string(from: base)
    let accts = (0..<n).map { "{\"id\":\"a\($0)\",\"label\":\"A\",\"balanceIncluded\":false,\"snapshot\":{\"state\":\"ready\"}}" }.joined(separator: ",")
    let json = "{\"schema\":\"iai-meter.portfolio.v1\",\"state\":\"ready\",\"generatedAt\":\"\(g)\",\"creditDayUtc\":\"\(TimeUtil.utcDay(base))\",\"resetsAt\":\"\(g)\",\"accountCount\":\(n),\"balanceAccountCount\":0,\"totals\":{\"reportedCreditUsd\":null,\"conservativeAvailableUsd\":null\(extra)}\(usage),\"accounts\":[\(accts)]}"
    let p = try? JSONDecoder().decode(Portfolio.self, from: Data(json.utf8))
    check(p != nil, "fixture decodes")
    return MeterViewModel(portfolio: p, now: base.addingTimeInterval(offset))
}
let u1 = ",\"usageAccountCount\":1"
let old = usageVM("")
check(old.usageCostText == "확인 안 됨" && old.requestCountText == "확인 안 됨", "old fields unknown")
check(old.averageRequestCostText == "확인 안 됨" && old.usageCoverageText == "사용량 반영 계정 확인 안 됨", "old avg/coverage unknown")
let zeroSpend = usageVM(",\"costUsd\":\"0.000000\",\"requests\":\"5\"", usage: u1)
check(zeroSpend.usageCostText == "$0.000000" && zeroSpend.averageRequestCostText == "$0.000000", "real zero spend")
let zeroReq = usageVM(",\"costUsd\":\"0.000000\",\"requests\":\"0\"", usage: u1)
check(zeroReq.requestCountText == "0회" && zeroReq.averageRequestCostText == "요청 없음", "zero requests")
let avg = usageVM(",\"costUsd\":\"1.234567\",\"requests\":\"12\"", usage: u1)
check(avg.averageRequestCostText == "$0.102880" && avg.requestCountText == "12회", "nonzero average")
check(avg.usageCostText == "$1.234567" && avg.usageCoverageText == "사용량 반영 1/1", "full coverage")
let part = usageVM(",\"costUsd\":\"1.234567\",\"requests\":\"12\"", usage: u1, n: 2)
check(part.usageCoverageText == "사용량 반영 1/2 (일부)" && part.usageCostText == "$1.234567 (일부)", "partial coverage")
let bad = usageVM(",\"costUsd\":\"1.000000\",\"requests\":\"1.5\"", usage: u1)
check(bad.requestCountText == "확인 안 됨" && bad.averageRequestCostText == "확인 안 됨", "malformed count")
check(usageVM(",\"requests\":12", usage: u1).requestCountText == "확인 안 됨", "numeric count rejected")
check(usageVM(",\"requests\":\"-3\"", usage: u1).requestCountText == "확인 안 됨", "signed count rejected")
let over = usageVM(",\"costUsd\":\"99999999999999.000000\",\"requests\":\"2\"", usage: u1)
check(over.averageRequestCostText == "확인 안 됨" && over.usageCostText == "$99,999,999,999,999.000000", "overflow avg unknown")
let stale = usageVM(",\"costUsd\":\"1.000000\",\"requests\":\"2\"", usage: u1, offset: 1000)
check(stale.usageCostText == "확인 안 됨" && stale.requestCountText == "확인 안 됨", "stale usage hidden")

print("\(passed) checks passed")
