import AppKit
import WebKit

@MainActor
final class Orumai: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate,
    WKDownloadDelegate
{
    private let home = URL(string: "https://app.dpeek.com/app")!
    private let webView = WKWebView()
    private var window: NSWindow!
    private var hasLoadedPage = false
    private var downloadDestinations: [WKDownload: URL] = [:]

    func applicationDidFinishLaunching(_ notification: Notification) {
        webView.navigationDelegate = self
        webView.uiDelegate = self
        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1120, height: 780),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Orumai"
        window.isReleasedWhenClosed = false
        window.contentView = webView
        let frameAutosaveName = "OneApp Main Window"
        window.setFrameAutosaveName(frameAutosaveName)
        if !window.setFrameUsingName(frameAutosaveName) {
            window.center()
        }

        configureMenus()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate()
        webView.load(URLRequest(url: home))
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    private func configureMenus() {
        let mainMenu = NSMenu()

        let appMenu = NSMenu(title: "Orumai")
        appMenu.addItem(withTitle: "Quit Orumai", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        mainMenu.addItem(withTitle: "Orumai", action: nil, keyEquivalent: "").submenu = appMenu

        let fileMenu = NSMenu(title: "File")
        fileMenu.addItem(withTitle: "Close Window", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        mainMenu.addItem(withTitle: "File", action: nil, keyEquivalent: "").submenu = fileMenu

        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(withTitle: "Undo", action: NSSelectorFromString("undo:"), keyEquivalent: "z")
        editMenu.addItem(withTitle: "Redo", action: NSSelectorFromString("redo:"), keyEquivalent: "Z")
        editMenu.addItem(.separator())
        editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        mainMenu.addItem(withTitle: "Edit", action: nil, keyEquivalent: "").submenu = editMenu

        let viewMenu = NSMenu(title: "View")
        let reloadItem = viewMenu.addItem(withTitle: "Reload", action: #selector(reload), keyEquivalent: "r")
        reloadItem.target = self
        mainMenu.addItem(withTitle: "View", action: nil, keyEquivalent: "").submenu = viewMenu
        NSApp.mainMenu = mainMenu
    }

    @objc private func reload() {
        if hasLoadedPage {
            webView.reload()
        } else {
            webView.load(URLRequest(url: home))
        }
    }

    private func isOrumai(_ url: URL) -> Bool {
        url.scheme == home.scheme && url.host == home.host && (url.port ?? 443) == 443
    }

    private func openExternalLink(_ url: URL, from action: WKNavigationAction) {
        guard action.navigationType == .linkActivated || action.navigationType == .other,
            action.sourceFrame.isMainFrame,
            let source = action.sourceFrame.request.url, isOrumai(source),
            url.scheme == "https" || url.scheme == "http" || url.scheme == "mailto"
        else { return }

        NSWorkspace.shared.open(url)
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async
        -> WKNavigationActionPolicy
    {
        guard let url = action.request.url else { return .cancel }
        let isOrumaiBlob = url.scheme == "blob" && action.sourceFrame.request.url.map(isOrumai) == true
        if isOrumai(url) || (isOrumaiBlob && action.shouldPerformDownload) {
            return action.shouldPerformDownload ? .download : .allow
        }
        if action.targetFrame?.isMainFrame == false { return .allow }
        openExternalLink(url, from: action)
        return .cancel
    }

    func webView(
        _ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
        for action: WKNavigationAction, windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        guard let url = action.request.url else { return nil }
        if isOrumai(url) {
            webView.load(action.request)
        } else {
            openExternalLink(url, from: action)
        }
        return nil
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        hasLoadedPage = true
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        guard !hasLoadedPage, (error as NSError).code != NSURLErrorCancelled else { return }
        let alert = NSAlert()
        alert.messageText = "Couldn’t open Orumai"
        alert.informativeText = error.localizedDescription
        alert.addButton(withTitle: "Retry")
        alert.addButton(withTitle: "Close")
        alert.beginSheetModal(for: window) { response in
            if response == .alertFirstButtonReturn {
                self.reload()
            } else {
                self.window.close()
            }
        }
    }

    func webView(
        _ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
        initiatedByFrame frame: WKFrameInfo
    ) async -> [URL]? {
        guard let source = frame.request.url, isOrumai(source) else { return nil }
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.canChooseFiles = !parameters.allowsDirectories
        return await panel.beginSheetModal(for: window) == .OK ? panel.urls : nil
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String)
        async -> URL?
    {
        guard let directory = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first else {
            return nil
        }
        let name = (suggestedFilename as NSString).lastPathComponent
        guard !name.isEmpty, name != ".", name != "..", name != "/" else { return nil }

        let file = name as NSString
        let stem = file.deletingPathExtension
        let suffix = file.pathExtension.isEmpty ? "" : ".\(file.pathExtension)"
        var destination = directory.appendingPathComponent(name)
        var copy = 2
        while FileManager.default.fileExists(atPath: destination.path)
            || downloadDestinations.values.contains(destination)
        {
            destination = directory.appendingPathComponent("\(stem) \(copy)\(suffix)")
            copy += 1
        }
        downloadDestinations[download] = destination
        return destination
    }

    func downloadDidFinish(_ download: WKDownload) {
        downloadDestinations.removeValue(forKey: download)
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        downloadDestinations.removeValue(forKey: download)
        window.presentError(error, modalFor: window, delegate: nil, didPresent: nil, contextInfo: nil)
    }
}

let application = NSApplication.shared
let delegate = Orumai()
application.setActivationPolicy(.regular)
application.delegate = delegate
application.run()
