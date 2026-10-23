import Foundation

/// Polls GET http://127.0.0.1:<port>/api/v1/status. Main-thread only: public API, state and onUpdate.
/// Memory-only; never logs bodies. Keeps last good portfolio on failure (hasError = true).
final class StatusClient: NSObject, URLSessionDataDelegate {
    static let minInterval: TimeInterval = 60
    static let maxBytes = 64 * 1024
    private static let backoff: [TimeInterval] = [60, 120, 300]

    var onUpdate: (() -> Void)?
    private(set) var portfolio: Portfolio?
    private(set) var hasError = false
    private(set) var lastSuccess: Date?

    private let url: URL?
    private var session: URLSession?
    private var task: URLSessionDataTask?
    private var buffer = Data()
    private var rejected = false
    private var timer: Timer?
    private var lastStart: Date?
    private var failures = 0

    init(port: Int) {
        url = (1...65535).contains(port) ? URL(string: "http://127.0.0.1:\(port)/api/v1/status") : nil
        super.init()
    }

    /// Creates the session and fetches (subject to the 60 s minimum interval).
    func start() {
        dispatchPrecondition(condition: .onQueue(.main))
        guard session == nil else { return }
        let cfg = URLSessionConfiguration.ephemeral
        cfg.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        cfg.urlCache = nil
        cfg.httpCookieStorage = nil
        cfg.httpShouldSetCookies = false
        cfg.httpCookieAcceptPolicy = .never
        cfg.urlCredentialStorage = nil
        cfg.timeoutIntervalForRequest = 5
        cfg.timeoutIntervalForResource = 5
        cfg.waitsForConnectivity = false
        cfg.httpMaximumConnectionsPerHost = 1
        session = URLSession(configuration: cfg, delegate: self, delegateQueue: .main)
        refresh()
    }

    /// Safe to call on wake/menu open: one in flight, at most once per 60 s.
    func refresh() {
        dispatchPrecondition(condition: .onQueue(.main))
        guard let session, task == nil else { return }
        guard let url else { fail(); return }
        if let last = lastStart {
            let wait = Self.minInterval - Date().timeIntervalSince(last)
            if wait > 0 { if timer == nil { schedule(wait) }; return }
        }
        timer?.invalidate(); timer = nil
        var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData, timeoutInterval: 5)
        req.httpMethod = "GET"
        req.httpShouldHandleCookies = false
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        buffer = Data(); rejected = false
        lastStart = Date()
        let t = session.dataTask(with: req)
        task = t
        t.resume()
    }

    /// Cancels task, timer and session (breaks the session->delegate retain).
    func stop() {
        dispatchPrecondition(condition: .onQueue(.main))
        timer?.invalidate(); timer = nil
        task?.cancel(); task = nil
        session?.invalidateAndCancel(); session = nil
        buffer = Data()
    }

    // MARK: URLSession delegate (main queue)

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard dataTask === task else { completionHandler(.cancel); return }
        guard let h = response as? HTTPURLResponse, h.statusCode == 200,
              h.expectedContentLength <= Int64(Self.maxBytes) else {
            rejected = true; completionHandler(.cancel); return
        }
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard dataTask === task, !rejected else { return }
        guard buffer.count + data.count <= Self.maxBytes else {
            rejected = true; buffer = Data(); dataTask.cancel(); return
        }
        buffer.append(data)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        completionHandler(.cancelAuthenticationChallenge, nil)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, willCacheResponse proposedResponse: CachedURLResponse,
                    completionHandler: @escaping (CachedURLResponse?) -> Void) {
        completionHandler(nil)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard task === self.task else { return } // ignore stale/duplicate completions
        self.task = nil
        let body = buffer; buffer = Data()
        guard error == nil, !rejected, (task.response as? HTTPURLResponse)?.statusCode == 200,
              let p = try? JSONDecoder().decode(Portfolio.self, from: body) else { fail(); return }
        portfolio = p // may be all-unknown; MeterViewModel then shows 확인 안 됨
        hasError = false
        lastSuccess = Date()
        failures = 0
        schedule(Self.minInterval)
        onUpdate?()
    }

    // MARK: private

    private func fail() {
        hasError = true
        failures += 1
        if url != nil, session != nil { schedule(Self.backoff[min(failures, Self.backoff.count) - 1]) }
        onUpdate?()
    }

    private func schedule(_ delay: TimeInterval) {
        timer?.invalidate()
        let t = Timer(timeInterval: max(delay, 1), repeats: false) { [weak self] _ in
            self?.timer = nil
            self?.refresh()
        }
        t.tolerance = 5
        RunLoop.main.add(t, forMode: .common)
        timer = t
    }
}
