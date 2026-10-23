import AppKit
import ServiceManagement

final class MenuBarController: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private let defaults = UserDefaults.standard
    private var client: StatusClient!
    private var panel: FloatingPanel!
    private var statusItem: NSStatusItem!
    private var timer: Timer?
    private var wakeObserver: NSObjectProtocol?
    private static let visKey = "panelVisible"

    func applicationDidFinishLaunching(_ n: Notification) {
        NSApp.setActivationPolicy(.accessory)
        defaults.register(defaults: [Self.visKey: true])
        let port = defaults.integer(forKey: "port")
        client = StatusClient(port: port > 0 ? port : 8877)
        panel = FloatingPanel()
        panel.title = "iAI Meter"
        panel.onVisibilityChange = { [weak self] v in self?.defaults.set(v, forKey: MenuBarController.visKey) }
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        let menu = NSMenu()
        menu.delegate = self
        statusItem.menu = menu
        client.onUpdate = { [weak self] in self?.updateUI() }
        updateUI()
        if ProcessInfo.processInfo.arguments.contains("--show-panel") || defaults.bool(forKey: Self.visKey) { panel.showPanel() }
        client.start()
        timer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in self?.updateUI() }
        wakeObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in
            self?.client.refresh()
            self?.updateUI()
        }
    }

    func applicationWillTerminate(_ n: Notification) {
        timer?.invalidate(); timer = nil
        client?.stop()
        if let o = wakeObserver { NSWorkspace.shared.notificationCenter.removeObserver(o) }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        guard panel != nil else { return true }
        panel.showPanel()
        defaults.set(true, forKey: Self.visKey)
        updateUI()
        return true
    }

    private func isPartial(_ p: Portfolio?) -> Bool {
        guard let p else { return false }
        return p.state == "partial" || p.balanceAccountCount < p.accountCount
    }

    private func stateLabel(_ s: String) -> String {
        switch s {
        case "ready": return "정상"
        case "partial": return "일부 확인"
        case "demo": return "예시"
        case "unconfigured": return "연결 필요"
        case "unknown": return "확인 안 됨"
        case "stale": return "오래됨"
        case "error": return "오류"
        default: return "확인 필요"
        }
    }

    private func updateUI() {
        let now = Date()
        let p = client.portfolio
        let vm = MeterViewModel(portfolio: p, now: now)
        let amt = (p?.balanceAccountCount ?? 0) > 0 ? p?.totals.conservativeAvailableUsd : nil
        let primary = amt?.formatted() ?? MeterViewModel.unknown
        var warn = client.hasError || vm.stale || isPartial(p)
        let secondary: String
        if p == nil { secondary = client.hasError ? "연결 확인" : "연결 중…" }
        else if client.hasError { secondary = "이전값 · 연결확인" }
        else if vm.stale { secondary = "오래됨 · 연결확인" }
        else {
            let p = p!
            let cov = "\(p.balanceAccountCount)/\(p.accountCount) 계정"
            if let d = TimeUtil.parse(p.resetsAt) {
                let t = d.timeIntervalSince(now)
                if !t.isFinite || t > 8 * 86400 { secondary = "초기화 ? · " + cov }
                else if t <= 0 { warn = true; secondary = "재조회대기 · " + cov }
                else { let s = Int(t); secondary = "초기화 \(s / 3600)h\((s % 3600) / 60)m · " + cov }
            } else { secondary = "초기화 ? · " + cov }
        }
        let details = (p?.accounts ?? []).prefix(8).map { a -> String in
            var s = a.label + " · " + (a.snapshot.balance?.conservativeAvailableUsd?.formatted() ?? MeterViewModel.unknown)
            if !a.balanceIncluded { s += " (제외)" }
            if a.snapshot.state != "ready" { s += " · " + stateLabel(a.snapshot.state) }
            return s
        }
        panel.update(primary: (vm.isDemo ? "DEMO " : "") + primary, secondary: secondary, details: Array(details), warning: warn)
        let title = "iAI " + (vm.isDemo ? "DEMO " : "") + primary + (warn ? " ⚠︎" : "")
        if let b = statusItem.button {
            b.title = title
            b.toolTip = title + " · " + secondary
            b.setAccessibilityTitle(title)
            b.setAccessibilityLabel("iAI Meter " + title)
        }
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        let now = Date(), p = client.portfolio
        let vm = MeterViewModel(portfolio: p, now: now)
        let df = DateFormatter(); df.dateStyle = .medium; df.timeStyle = .short
        func info(_ s: String) { let i = NSMenuItem(title: s, action: nil, keyEquivalent: ""); i.isEnabled = false; menu.addItem(i) }
        func act(_ t: String, _ s: Selector, _ k: String = "") -> NSMenuItem {
            let i = NSMenuItem(title: t, action: s, keyEquivalent: k); i.target = self; menu.addItem(i); return i
        }
        info((vm.isDemo ? "DEMO 데모 · " : "") + "합계 (USD) " + vm.balanceText)
        info("USD 크레딧 · 간단 표시는 소수 2자리 버림, 계정별은 6자리")
        info("확정 전 사용액이 반영되면 가용액이 바뀔 수 있음")
        info(vm.coverageText + (isPartial(p) ? " · 일부만 반영" : ""))
        if let s = p?.resetsAt, let d = TimeUtil.parse(s) { info("초기화 " + df.string(from: d) + " · " + vm.resetText) }
        else { info(vm.resetText) }
        if vm.stale || client.hasError {
            let last = client.lastSuccess.map { df.string(from: $0) } ?? MeterViewModel.unknown
            info("⚠︎ " + (client.hasError ? "연결 오류" : "오래된 데이터") + " · 마지막 성공 " + last)
        }
        let accts = (p?.accounts ?? []).prefix(8)
        if !accts.isEmpty {
            menu.addItem(.separator())
            for a in accts {
                let amt = a.snapshot.balance?.conservativeAvailableUsd?.formatted(full: true) ?? MeterViewModel.unknown
                info("\(a.label): \(amt) · \(stateLabel(a.snapshot.state))" + (a.balanceIncluded ? "" : " (제외)"))
            }
        }
        menu.addItem(.separator())
        act("플로팅 패널 보기", #selector(togglePanel), "p").state = panel.isVisible ? .on : .off
        _ = act("지금 새로 고침 (최소 60초 간격)", #selector(refreshNow))
        act("로그인 시 실행", #selector(toggleLogin)).state = SMAppService.mainApp.status == .enabled ? .on : .off
        info("맥 메뉴 막대 · 작은 창")
        menu.addItem(.separator())
        _ = act("iAI Meter 종료", #selector(quit), "q")
    }

    @objc private func togglePanel() {
        if panel.isVisible { panel.hidePanel() } else { panel.showPanel() }
        defaults.set(panel.isVisible, forKey: Self.visKey)
    }

    @objc private func refreshNow() { client.refresh(); updateUI() }

    @objc private func toggleLogin() {
        let svc = SMAppService.mainApp
        do {
            if svc.status == .enabled { try svc.unregister() } else { try svc.register() }
        } catch {
            let a = NSAlert()
            a.messageText = "로그인 시 실행 설정 실패"
            a.informativeText = error.localizedDescription
            a.alertStyle = .warning
            a.runModal()
        }
    }

    @objc private func quit() { NSApp.terminate(nil) }
}
