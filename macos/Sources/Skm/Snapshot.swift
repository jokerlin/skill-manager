import AppKit
import SwiftUI

/// Headless self-screenshot for docs/CI: run the app with SKM_SNAPSHOT=/path/base and it writes
/// /path/base-<section>.png for every section once data is loaded, then quits.
/// Renders its own window, so no Screen Recording permission is needed.
@MainActor
enum Snapshot {
    static var requestedBase: String? {
        let v = ProcessInfo.processInfo.environment["SKM_SNAPSHOT"] ?? ""
        return v.isEmpty ? nil : v
    }

    private static func log(_ s: String) { FileHandle.standardError.write(Data("[snapshot] \(s)\n".utf8)) }

    /// Unstructured task so SwiftUI view lifecycle cannot cancel it.
    static func scheduleIfRequested(_ model: AppModel) {
        guard let base = requestedBase else { return }
        Task { @MainActor in await run(model, base: base) }
    }

    private static func run(_ model: AppModel, base: String) async {
        log("waiting for data (base \(base))")
        for _ in 0..<240 where model.hosts.isEmpty || model.busy != nil { try? await Task.sleep(for: .milliseconds(500)) }
        log("data ready: \(model.skills.count) skills, \(model.hosts.count) hosts, busy=\(model.busy ?? "nil")")
        for section in Section.allCases {
            model.section = section
            try? await Task.sleep(for: .milliseconds(900))
            guard let window = NSApp.windows.first(where: { $0.isVisible && $0.contentView != nil }) else { log("no visible window"); continue }
            let path = "\(base)-\(section.rawValue).png"
            // SKM_SNAPSHOT_OFFSCREEN=1 renders through the view hierarchy instead of the display (works with the screen locked / display asleep)
            let offscreen = ProcessInfo.processInfo.environment["SKM_SNAPSHOT_OFFSCREEN"] == "1"
            if let data = (offscreen ? nil : windowImage(window)) ?? viewImage(window.contentView!) {
                do { try data.write(to: URL(fileURLWithPath: path)); log("wrote \(path) (\(data.count) bytes)") } catch { log("write failed: \(error)") }
            } else { log("no image for \(section.rawValue)") }
        }
        log("done, quitting")
        NSApp.terminate(nil)
    }

    /// Whole window incl. title bar via CoreGraphics (own window).
    private static func windowImage(_ window: NSWindow) -> Data? {
        let id = CGWindowID(window.windowNumber)
        guard let cg = CGWindowListCreateImage(.null, .optionIncludingWindow, id, [.boundsIgnoreFraming, .bestResolution]), cg.width > 1 else { return nil }
        return NSBitmapImageRep(cgImage: cg).representation(using: .png, properties: [:])
    }

    /// Fallback: content view only, rendered through the view hierarchy (works with the screen locked).
    /// The content view is transparent where the window background would show, so composite it onto a light ground.
    private static func viewImage(_ view: NSView) -> Data? {
        guard let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return nil }
        view.cacheDisplay(in: view.bounds, to: rep)
        guard let cg = rep.cgImage,
              let ctx = CGContext(data: nil, width: cg.width, height: cg.height, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
        else { return rep.representation(using: .png, properties: [:]) }
        let full = CGRect(x: 0, y: 0, width: cg.width, height: cg.height)
        ctx.setFillColor(CGColor(gray: 0.98, alpha: 1))
        ctx.fill(full)
        ctx.draw(cg, in: full)
        guard let out = ctx.makeImage() else { return rep.representation(using: .png, properties: [:]) }
        return NSBitmapImageRep(cgImage: out).representation(using: .png, properties: [:])
    }
}
