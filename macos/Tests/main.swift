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

print("\(passed) checks passed")
