import Foundation

/// Thin client over the `skm` CLI. Every method shells out and decodes `--json`.
/// Nothing here knows about stores, symlinks or ssh — that logic lives once, in the CLI.
final class Engine: @unchecked Sendable {
    enum EngineError: LocalizedError {
        case notFound
        case failed(code: Int32, stderr: String)
        case decode(String)

        var errorDescription: String? {
            switch self {
            case .notFound: return "skm CLI not found. Set its path in Settings (⌘,) — e.g. ~/.local/bin/skm or `bun run <repo>/bin/skm.ts`."
            case let .failed(code, stderr): return "skm exited \(code): \(stderr.trimmingCharacters(in: .whitespacesAndNewlines))"
            case let .decode(msg): return "could not decode skm output: \(msg)"
            }
        }
    }

    static let shared = Engine()

    /// Command line prefix, e.g. ["/Users/me/.local/bin/skm"] or ["bun", "run", "/repo/bin/skm.ts"].
    var command: [String] {
        if let custom = UserDefaults.standard.string(forKey: "skmCommand"), !custom.isEmpty {
            return custom.split(separator: " ").map(String.init)
        }
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        for candidate in ["\(home)/.local/bin/skm", "/opt/homebrew/bin/skm", "/usr/local/bin/skm"] where FileManager.default.isExecutableFile(atPath: candidate) {
            return [candidate]
        }
        return []
    }

    private func resolve(_ argv0: String) -> String {
        if argv0.hasPrefix("/") { return argv0 }
        let path = (ProcessInfo.processInfo.environment["PATH"] ?? "") + ":\(FileManager.default.homeDirectoryForCurrentUser.path)/.bun/bin:/opt/homebrew/bin:/usr/local/bin"
        for dir in path.split(separator: ":") {
            let p = "\(dir)/\(argv0)"
            if FileManager.default.isExecutableFile(atPath: p) { return p }
        }
        return argv0
    }

    /// Run `skm <args>` and return stdout. Runs off the main thread.
    func run(_ args: [String]) async throws -> String {
        let cmd = command
        guard let first = cmd.first else { throw EngineError.notFound }
        return try await withCheckedThrowingContinuation { cont in
            DispatchQueue.global(qos: .userInitiated).async {
                let p = Process()
                p.executableURL = URL(fileURLWithPath: self.resolve(first))
                p.arguments = Array(cmd.dropFirst()) + args
                var env = ProcessInfo.processInfo.environment
                env["PATH"] = (env["PATH"] ?? "/usr/bin:/bin") + ":\(FileManager.default.homeDirectoryForCurrentUser.path)/.bun/bin:/opt/homebrew/bin:/usr/local/bin"
                env["NO_COLOR"] = "1"
                p.environment = env
                let out = Pipe(), err = Pipe()
                p.standardOutput = out
                p.standardError = err
                do { try p.run() } catch { cont.resume(throwing: EngineError.notFound); return }
                let stdout = String(decoding: out.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
                let stderr = String(decoding: err.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
                p.waitUntilExit()
                if p.terminationStatus != 0 { cont.resume(throwing: EngineError.failed(code: p.terminationStatus, stderr: stderr)) } else { cont.resume(returning: stdout) }
            }
        }
    }

    /// Stream stdout lines of a long-running command (sync, eval, backup).
    func stream(_ args: [String]) -> AsyncThrowingStream<String, Error> {
        AsyncThrowingStream { cont in
            let cmd = command
            guard let first = cmd.first else { cont.finish(throwing: EngineError.notFound); return }
            DispatchQueue.global(qos: .userInitiated).async {
                let p = Process()
                p.executableURL = URL(fileURLWithPath: self.resolve(first))
                p.arguments = Array(cmd.dropFirst()) + args
                var env = ProcessInfo.processInfo.environment
                env["PATH"] = (env["PATH"] ?? "/usr/bin:/bin") + ":\(FileManager.default.homeDirectoryForCurrentUser.path)/.bun/bin:/opt/homebrew/bin:/usr/local/bin"
                env["NO_COLOR"] = "1"
                p.environment = env
                let out = Pipe()
                p.standardOutput = out
                p.standardError = out
                out.fileHandleForReading.readabilityHandler = { h in
                    let data = h.availableData
                    if data.isEmpty { return }
                    String(decoding: data, as: UTF8.self).split(separator: "\n", omittingEmptySubsequences: true).forEach { cont.yield(String($0)) }
                }
                p.terminationHandler = { proc in
                    out.fileHandleForReading.readabilityHandler = nil
                    let rest = out.fileHandleForReading.readDataToEndOfFile()
                    String(decoding: rest, as: UTF8.self).split(separator: "\n", omittingEmptySubsequences: true).forEach { cont.yield(String($0)) }
                    if proc.terminationStatus == 0 { cont.finish() } else { cont.finish(throwing: EngineError.failed(code: proc.terminationStatus, stderr: "")) }
                }
                do { try p.run() } catch { cont.finish(throwing: EngineError.notFound) }
            }
        }
    }

    private func decode<T: Decodable>(_ type: T.Type, _ text: String) throws -> T {
        do { return try JSONDecoder().decode(type, from: Data(text.utf8)) } catch { throw EngineError.decode("\(error)  —  \(text.prefix(200))") }
    }

    func skills() async throws -> [SkillRow] { try decode([SkillRow].self, await run(["ls", "--json"])) }
    func status() async throws -> [HostStatus] { try decode([HostStatus].self, await run(["status", "--json"])) }
    func plan() async throws -> [HostPlan] { try decode([HostPlan].self, await run(["plan", "--json"])) }
    /// `--cached` reuses the probe `status` just wrote, so a refresh costs two ssh round-trips (status + plan), not three.
    func doctor(cached: Bool = true) async throws -> DoctorReport { try decode(DoctorReport.self, await run(["doctor", "--json"] + (cached ? ["--cached"] : []))) }
    func evals() async throws -> [EvalItem] { try decode([EvalItem].self, await run(["eval", "--json", "--cached"])) }
    func config() async throws -> ConfigSummary { try decode(ConfigSummary.self, await run(["config", "--json"])) }
    func setScope(skill: String, host: String, agent: String, on: Bool) async throws { _ = try await run(["scope", skill, "\(host)/\(agent)", on ? "on" : "off"]) }
    func sync(replaceConflicts: Bool) -> AsyncThrowingStream<String, Error> { stream(["sync", "-y"] + (replaceConflicts ? ["--replace-conflicts"] : [])) }
    func backup() -> AsyncThrowingStream<String, Error> { stream(["backup"]) }
    func evaluate(fresh: Bool) -> AsyncThrowingStream<String, Error> { stream(["eval"] + (fresh ? ["--fresh"] : [])) }
}
