import Foundation
import ExpoModulesCore

internal final class InvalidBookmarkException: Exception {
  override var reason: String {
    "Sync path bookmark could not be decoded or resolved"
  }
}

public class SyncPathBookmarksModule: Module {
  private var activeScopedUrl: URL?

  private var bookmarkCreationOptions: URL.BookmarkCreationOptions {
    #if os(macOS)
      return .withSecurityScope
    #else
      return []
    #endif
  }

  private var bookmarkResolutionOptions: URL.BookmarkResolutionOptions {
    #if os(macOS)
      return .withSecurityScope
    #else
      return []
    #endif
  }

  public func definition() -> ModuleDefinition {
    Name("SyncPathBookmarks")

    OnDestroy {
      self.stopActiveScopedAccess()
    }

    AsyncFunction("createBookmark") { (url: URL) -> String? in
      let didStartAccessing = url.startAccessingSecurityScopedResource()
      defer {
        if didStartAccessing {
          url.stopAccessingSecurityScopedResource()
        }
      }

      let bookmarkData = try url.bookmarkData(
        options: self.bookmarkCreationOptions,
        includingResourceValuesForKeys: nil,
        relativeTo: nil
      )

      return bookmarkData.base64EncodedString()
    }

    AsyncFunction("resolveBookmark") { (bookmarkBase64: String) -> [String: String?]? in
      guard let resolved = try self.resolveBookmarkUrl(bookmarkBase64) else {
        return nil
      }


      self.startActiveScopedAccess(resolved.url)

      var refreshedBookmark: String? = nil
      if resolved.isStale {
        refreshedBookmark = (try? resolved.url.bookmarkData(
          options: self.bookmarkCreationOptions,
          includingResourceValuesForKeys: nil,
          relativeTo: nil
        ))?.base64EncodedString()
      }

      return ["uri": resolved.url.absoluteString, "refreshedBookmark": refreshedBookmark]
    }

    AsyncFunction("readTextFile") { (bookmarkBase64: String) -> String? in
      guard let resolved = try self.resolveBookmarkUrl(bookmarkBase64) else {
        throw InvalidBookmarkException()
      }

      return try self.withScopedAccess(resolved.url) { url in
        var coordinatorError: NSError?
        var text: String?
        var accessError: Error?
        NSFileCoordinator(filePresenter: nil).coordinate(
          readingItemAt: url,
          options: [],
          error: &coordinatorError
        ) { coordinatedUrl in
          guard FileManager.default.fileExists(atPath: coordinatedUrl.path) else {
            return
          }
          do {
            text = try String(contentsOf: coordinatedUrl, encoding: .utf8)
          } catch {
            accessError = error
          }
        }
        if let coordinatorError {
          throw coordinatorError
        }
        if let accessError {
          throw accessError
        }
        return text
      }
    }

    AsyncFunction("writeTextFile") { (bookmarkBase64: String, content: String) in
      guard let resolved = try self.resolveBookmarkUrl(bookmarkBase64) else {
        throw InvalidBookmarkException()
      }

      try self.withScopedAccess(resolved.url) { url in
        var coordinatorError: NSError?
        var accessError: Error?
        NSFileCoordinator(filePresenter: nil).coordinate(
          writingItemAt: url,
          options: .forReplacing,
          error: &coordinatorError
        ) { coordinatedUrl in
          do {
            try Data(content.utf8).write(to: coordinatedUrl, options: .atomic)
          } catch {
            accessError = error
          }
        }
        if let coordinatorError {
          throw coordinatorError
        }
        if let accessError {
          throw accessError
        }
      }
    }
  }

  private func resolveBookmarkUrl(_ bookmarkBase64: String) throws -> (url: URL, isStale: Bool)? {
    guard let bookmarkData = Data(base64Encoded: bookmarkBase64) else {
      return nil
    }

    var isStale = false
    let resolvedUrl = try URL(
      resolvingBookmarkData: bookmarkData,
      options: bookmarkResolutionOptions,
      relativeTo: nil,
      bookmarkDataIsStale: &isStale
    )

    return (resolvedUrl, isStale)
  }

  private func withScopedAccess<T>(_ url: URL, _ work: (URL) throws -> T) rethrows -> T {
    let didStartAccessing = url.startAccessingSecurityScopedResource()
    defer {
      if didStartAccessing {
        url.stopAccessingSecurityScopedResource()
      }
    }
    return try work(url)
  }

  private func startActiveScopedAccess(_ url: URL) {
    stopActiveScopedAccess()

    if url.startAccessingSecurityScopedResource() {
      activeScopedUrl = url
    }
  }

  private func stopActiveScopedAccess() {
    guard let activeScopedUrl = activeScopedUrl else {
      return
    }

    activeScopedUrl.stopAccessingSecurityScopedResource()
    self.activeScopedUrl = nil
  }
}
