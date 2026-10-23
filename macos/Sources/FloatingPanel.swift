import AppKit

private final class DragView: NSVisualEffectView {
    override var isFlipped: Bool { true }
    override var mouseDownCanMoveWindow: Bool { true }
    override func mouseDown(with event: NSEvent) { window?.performDrag(with: event) }
}

final class FloatingPanel: NSPanel {
    var onVisibilityChange: ((Bool) -> Void)?

    private let w: CGFloat = 232
    private let baseH: CGFloat = 64
    private let lineH: CGFloat = 16
    private let posKey = "FloatingPanel.topLeft"
    private let bg = DragView()
    private let primaryLabel = FloatingPanel.label(17, .semibold, .labelColor)
    private let secondaryLabel = FloatingPanel.label(11, .regular, .secondaryLabelColor)
    private let macLabel = FloatingPanel.label(9, .medium, .tertiaryLabelColor)
    private let expandButton = NSButton()
    private let closeButton = NSButton()
    private var detailLabels: [NSTextField] = []
    private var details: [String] = []
    private var expanded = false

    init() {
        super.init(contentRect: NSRect(x: 0, y: 0, width: 232, height: 64),
                   styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        level = .floating
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        hidesOnDeactivate = false
        isFloatingPanel = true
        becomesKeyOnlyIfNeeded = true
        isOpaque = false
        backgroundColor = .clear
        hasShadow = true
        isMovableByWindowBackground = true
        isReleasedWhenClosed = false

        bg.material = .hudWindow
        bg.blendingMode = .behindWindow
        bg.state = .active
        bg.wantsLayer = true
        bg.layer?.cornerRadius = 10
        bg.layer?.masksToBounds = true
        contentView = bg

        macLabel.stringValue = "Mac"
        macLabel.alignment = .right
        configure(closeButton, symbol: "xmark", ax: "패널 숨기기", action: #selector(hideAction))
        configure(expandButton, symbol: "chevron.down", ax: "계정 상세 펼치기", action: #selector(toggleExpand))
        [primaryLabel, secondaryLabel, macLabel, expandButton, closeButton].forEach { bg.addSubview($0) }

        let menu = NSMenu()
        let item = NSMenuItem(title: "숨기기", action: #selector(hideAction), keyEquivalent: "")
        item.target = self
        menu.addItem(item)
        bg.menu = menu

        let nc = NotificationCenter.default
        nc.addObserver(self, selector: #selector(didMove), name: NSWindow.didMoveNotification, object: self)
        nc.addObserver(self, selector: #selector(screensChanged),
                       name: NSApplication.didChangeScreenParametersNotification, object: nil)
        layoutContent()
    }

    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }

    func update(primary: String, secondary: String, details: [String], warning: Bool) {
        primaryLabel.stringValue = primary
        primaryLabel.toolTip = primary
        primaryLabel.textColor = warning ? .systemOrange : .labelColor
        secondaryLabel.stringValue = secondary
        secondaryLabel.toolTip = secondary
        secondaryLabel.textColor = warning ? .systemOrange : .secondaryLabelColor
        self.details = Array(details.prefix(14))
        expandButton.isEnabled = !self.details.isEmpty
        if self.details.isEmpty { expanded = false }
        layoutContent()
    }

    func showPanel() {
        let d = UserDefaults.standard
        if let a = d.array(forKey: posKey) as? [Double], a.count == 2 {
            setFrameTopLeftPoint(NSPoint(x: a[0], y: a[1]))
        } else if let vf = (NSScreen.main ?? NSScreen.screens.first)?.visibleFrame {
            setFrameTopLeftPoint(NSPoint(x: vf.maxX - frame.width - 16, y: vf.maxY - 12))
        }
        clampToScreen()
        orderFrontRegardless()
        onVisibilityChange?(true)
    }

    func hidePanel() {
        orderOut(nil)
        onVisibilityChange?(false)
    }

    @objc private func hideAction() { hidePanel() }

    @objc private func toggleExpand() {
        expanded.toggle()
        layoutContent()
        clampToScreen()
    }

    @objc private func didMove() {
        UserDefaults.standard.set([Double(frame.minX), Double(frame.maxY)], forKey: posKey)
    }

    @objc private func screensChanged() { if isVisible { clampToScreen() } }

    private func layoutContent() {
        detailLabels.forEach { $0.removeFromSuperview() }
        detailLabels = []
        let shown = expanded ? details : []
        for (i, text) in shown.enumerated() {
            let l = FloatingPanel.label(11, .regular, .labelColor)
            l.stringValue = text
            l.toolTip = text
            l.frame = NSRect(x: 12, y: baseH - 4 + CGFloat(i) * lineH, width: w - 24, height: 15)
            bg.addSubview(l)
            detailLabels.append(l)
        }
        let h = baseH + (shown.isEmpty ? 0 : CGFloat(shown.count) * lineH + 4)
        let top = frame.maxY
        setFrame(NSRect(x: frame.minX, y: top - h, width: w, height: h), display: true)
        bg.frame = NSRect(x: 0, y: 0, width: w, height: h)
        primaryLabel.frame = NSRect(x: 12, y: 9, width: w - 12 - 84, height: 22)
        macLabel.frame = NSRect(x: w - 84, y: 13, width: 30, height: 12)
        expandButton.frame = NSRect(x: w - 50, y: 8, width: 18, height: 18)
        closeButton.frame = NSRect(x: w - 28, y: 8, width: 18, height: 18)
        secondaryLabel.frame = NSRect(x: 12, y: 36, width: w - 24, height: 15)
        let sym = expanded ? "chevron.up" : "chevron.down"
        let ax = expanded ? "계정 상세 접기" : "계정 상세 펼치기"
        expandButton.image = NSImage(systemSymbolName: sym, accessibilityDescription: ax)
        expandButton.setAccessibilityLabel(ax)
        expandButton.toolTip = ax
    }

    private func clampToScreen() {
        let screen = NSScreen.screens.first { $0.visibleFrame.intersects(frame) } ?? NSScreen.main ?? NSScreen.screens.first
        guard let vf = screen?.visibleFrame else { return }
        var o = frame.origin
        o.x = min(max(o.x, vf.minX), vf.maxX - frame.width)
        o.y = min(max(o.y, vf.minY), vf.maxY - frame.height)
        if o != frame.origin { setFrameOrigin(o) }
    }

    private func configure(_ b: NSButton, symbol: String, ax: String, action: Selector) {
        b.image = NSImage(systemSymbolName: symbol, accessibilityDescription: ax)
        b.imagePosition = .imageOnly
        b.isBordered = false
        b.bezelStyle = .inline
        b.contentTintColor = .secondaryLabelColor
        b.target = self
        b.action = action
        b.toolTip = ax
        b.setAccessibilityLabel(ax)
    }

    private static func label(_ size: CGFloat, _ weight: NSFont.Weight, _ color: NSColor) -> NSTextField {
        let l = NSTextField(labelWithString: "")
        l.font = .systemFont(ofSize: size, weight: weight)
        l.textColor = color
        l.lineBreakMode = .byTruncatingTail
        l.maximumNumberOfLines = 1
        l.isSelectable = false
        return l
    }
}
