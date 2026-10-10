import Foundation

enum NativeCalendarEventEditorOutcome: String {
    case cancelled, saved, deleted
}

/// The editor's actual UUID lifetime; independent of Calendar page publication.
struct NativeCalendarEventEditorLifetime {
    enum Phase { case unstarted, started, closed }
    let id: UUID
    private(set) var phase: Phase = .unstarted
    private(set) var wasPresented = false
    private(set) var outcome: NativeCalendarEventEditorOutcome?
    private(set) var cancelled = false
    private(set) var delegateCompleted = false
    private(set) var hasStarted = false

    var canStart: Bool { phase == .unstarted && !cancelled }
    var requiresDraftCancellation: Bool { phase != .closed && cancelled && !delegateCompleted }

    mutating func start(_ capturedID: UUID) -> Bool {
        guard capturedID == id, canStart else { return false }
        phase = .started
        hasStarted = true
        return true
    }
    mutating func didAppear(_ capturedID: UUID) -> Bool {
        guard capturedID == id, phase == .started, !cancelled else { return false }
        wasPresented = true
        return true
    }
    mutating func completeDelegate(_ capturedID: UUID, outcome next: NativeCalendarEventEditorOutcome) -> Bool {
        guard capturedID == id, phase == .started, outcome == nil, !delegateCompleted else { return false }
        outcome = next
        delegateCompleted = true
        return true
    }
    mutating func cancel() {
        guard phase != .closed else { return }
        cancelled = true
        if outcome == nil { outcome = .cancelled }
    }
    mutating func observeTransitionCompletion(registered: Bool) -> Bool {
        guard canStart else { return false }
        if !registered { cancel() }
        return registered
    }
    @discardableResult
    mutating func finish(_ capturedID: UUID) -> Bool {
        guard capturedID == id, phase != .closed else { return false }
        if outcome == nil { outcome = .cancelled }
        phase = .closed
        return true
    }
}

#if os(iOS) && canImport(EventKitUI)
import SwiftUI
import UIKit
import EventKitUI
import MindwtrNativeCore

/// Privacy and dismissal are confined to this editor's actual UIKit owner.
@MainActor
final class NativeCalendarEventEditorOwnedUI {
    private var cover: UIView?

    func conceal(_ editor: UIViewController) {
        guard editor.isViewLoaded else { return }
        let content = editor.view!
        // A full-screen child can detach editor.view; follow only its owned chain.
        var container: UIView = content
        var controller: UIViewController? = editor
        while let owned = controller {
            if let view = owned.viewIfLoaded {
                if let window = view.window { container = window }
                view.accessibilityElementsHidden = true
            }
            controller = owned.presentedViewController
        }
        let cover = self.cover ?? UIView()
        cover.backgroundColor = .systemBackground
        cover.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        cover.isAccessibilityElement = false
        if cover.superview !== container { container.addSubview(cover) }
        cover.frame = container.bounds
        container.bringSubviewToFront(cover)
        self.cover = cover
    }

    func release() {
        cover?.removeFromSuperview()
        cover = nil
    }

    static func dismissalPresenter(for editor: UIViewController) -> UIViewController? {
        guard let presenter = editor.presentingViewController,
              presenter.presentedViewController === editor else { return nil }
        return presenter
    }
}

@MainActor
final class NativeCalendarEventEditorPresentation: Identifiable {
    let id: UUID
    let owner: NativeCalendarEventOpenOwner
    private var lifetime: NativeCalendarEventEditorLifetime
    private var editor: EKEventEditViewController?
    private var delegate: NativeCalendarEventEditorDelegate?
    private var host: NativeCalendarEventEditorHost?
    private let ownedUI = NativeCalendarEventEditorOwnedUI()
    private var draftCancelled = false
    private var resourcesReleased = false

    var wasPresented: Bool { lifetime.wasPresented }
    var outcome: NativeCalendarEventEditorOutcome? { lifetime.outcome }
    var hasStarted: Bool { lifetime.hasStarted }
    fileprivate var canStart: Bool { lifetime.canStart }
    fileprivate var cancelled: Bool { lifetime.cancelled }
    fileprivate var controller: EKEventEditViewController? { editor }

    init(id: UUID, owner: NativeCalendarEventOpenOwner) {
        self.id = id
        self.owner = owner
        lifetime = NativeCalendarEventEditorLifetime(id: id)
    }

    /// Synchronous privacy protection, including when App lock is disabled.
    func concealAndCancel() {
        lifetime.cancel()
        guard !resourcesReleased else { return }
        keepCovered()
        // cancelEditing does not call the edit delegate. The model still closes
        // its binding, and this host owns actual dismissal completion.
        if lifetime.requiresDraftCancellation, !draftCancelled, let editor {
            draftCancelled = true
            editor.cancelEditing()
        }
    }

    /// Called only after confirmed dismissal, or cancellation before any start.
    func finishDismissal() {
        lifetime.finish(id)
        guard !resourcesReleased else { return }
        resourcesReleased = true
        ownedUI.release()
        editor?.editViewDelegate = nil
        editor = nil
        delegate = nil
        host = nil
        // wasPresented/outcome remain terminal witnesses for the model.
    }

    fileprivate func claim(_ host: NativeCalendarEventEditorHost) -> Bool {
        guard lifetime.start(id) else { return false }
        self.host = host
        return true
    }
    fileprivate func install(_ editor: EKEventEditViewController, delegate: NativeCalendarEventEditorDelegate) {
        self.editor = editor
        self.delegate = delegate
        if cancelled { concealAndCancel() }
    }
    fileprivate func didAppear() { _ = lifetime.didAppear(id) }
    fileprivate func completeDelegate(_ outcome: NativeCalendarEventEditorOutcome) -> Bool {
        lifetime.completeDelegate(id, outcome: outcome)
    }
    fileprivate func observeTransitionCompletion(registered: Bool) -> Bool {
        lifetime.observeTransitionCompletion(registered: registered)
    }
    fileprivate func keepCovered() {
        guard cancelled, !resourcesReleased, let editor else { return }
        ownedUI.conceal(editor)
    }
}

/// A stable root child owns UIKit presentation, including pre-mount cancellation.
@MainActor
struct NativeCalendarEventEditor: UIViewControllerRepresentable {
    let presentation: NativeCalendarEventEditorPresentation?
    let isPresented: Bool
    let canPresent: @MainActor (UUID) -> Bool
    let requestDismiss: @MainActor (UUID, NativeCalendarEventEditorOutcome) -> Void
    let didDismiss: @MainActor (UUID) -> Void

    func makeUIViewController(context: Context) -> UIViewController {
        let host = NativeCalendarEventEditorHost()
        host.update(configuration)
        return host
    }
    func updateUIViewController(_ controller: UIViewController, context: Context) {
        (controller as? NativeCalendarEventEditorHost)?.update(configuration)
    }
    static func dismantleUIViewController(_ controller: UIViewController, coordinator: ()) {
        (controller as? NativeCalendarEventEditorHost)?.shutdown()
    }
    private var configuration: NativeCalendarEventEditorConfiguration {
        .init(presentation: presentation, isPresented: isPresented, canPresent: canPresent,
              requestDismiss: requestDismiss, didDismiss: didDismiss)
    }
}

@MainActor
fileprivate struct NativeCalendarEventEditorConfiguration {
    let presentation: NativeCalendarEventEditorPresentation?
    let isPresented: Bool
    let canPresent: @MainActor (UUID) -> Bool
    let requestDismiss: @MainActor (UUID, NativeCalendarEventEditorOutcome) -> Void
    let didDismiss: @MainActor (UUID) -> Void
}

@MainActor
fileprivate final class NativeCalendarEventEditorHost: UIViewController {
    private var configuration: NativeCalendarEventEditorConfiguration?
    private var active: NativeCalendarEventEditorPresentation?
    private var activeRequestDismiss: (@MainActor (UUID, NativeCalendarEventEditorOutcome) -> Void)?
    private var activeDidDismiss: (@MainActor (UUID) -> Void)?
    private var presentationCompleted = false
    private var dismissalInFlight = false
    private var waitingForTransition = false

    override func loadView() {
        let anchor = UIView()
        anchor.backgroundColor = .clear
        anchor.isUserInteractionEnabled = false
        anchor.isAccessibilityElement = false
        anchor.accessibilityElementsHidden = true
        view = anchor
    }
    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        reconcile()
    }

    func update(_ next: NativeCalendarEventEditorConfiguration) {
        configuration = next
        reconcile()
    }
    func shutdown() {
        configuration = nil
        guard let active else { return }
        active.concealAndCancel()
        activeRequestDismiss?(active.id, active.outcome ?? .cancelled)
        dismissIfNeeded(active)
    }

    private func reconcile() {
        if let active {
            if configuration?.presentation !== active || configuration?.isPresented != true || active.cancelled {
                active.concealAndCancel()
                dismissIfNeeded(active)
            }
            return
        }
        guard let configuration, let next = configuration.presentation else { return }
        guard configuration.isPresented, next.canStart, !next.cancelled else {
            if !next.hasStarted {
                next.concealAndCancel()
                configuration.requestDismiss(next.id, next.outcome ?? .cancelled)
            }
            return
        }
        guard isViewLoaded, view.window != nil else { return }
        guard configuration.canPresent(next.id) else {
            next.concealAndCancel()
            configuration.requestDismiss(next.id, .cancelled)
            return
        }
        guard anchorAvailable(for: next) else { return }
        // No await between exact admission, claim and the actual present call.
        guard configuration.canPresent(next.id), next.claim(self) else { return }
        active = next
        activeRequestDismiss = configuration.requestDismiss
        activeDidDismiss = configuration.didDismiss
        presentationCompleted = false
        dismissalInFlight = false

        let editor = NativeCalendarEventEditorController(presentation: next, host: self)
        let delegate = NativeCalendarEventEditorDelegate(presentation: next, host: self)
        editor.eventStore = next.owner.eventStore
        editor.event = next.owner.event
        editor.editViewDelegate = delegate
        next.install(editor, delegate: delegate)
        guard canShow(next) else {
            next.concealAndCancel()
            activeRequestDismiss?(next.id, .cancelled)
            complete(next) // The editor has not been submitted to UIKit.
            return
        }
        present(editor, animated: true) { [self, next] in
            guard active === next else { return }
            presentationCompleted = true
            if next.cancelled || self.configuration?.presentation !== next || self.configuration?.isPresented != true {
                next.concealAndCancel()
                dismissIfNeeded(next)
            }
        }
        // This is our UIKit presentation, not a SwiftUI-owned adaptive delegate.
        editor.presentationController?.delegate = delegate
    }

    private func anchorAvailable(for next: NativeCalendarEventEditorPresentation) -> Bool {
        var ancestor: UIViewController? = self
        while let controller = ancestor {
            let transitionOwner = controller.presentedViewController?.isBeingDismissed == true
                ? controller.presentedViewController : controller
            if controller.isBeingPresented || controller.isBeingDismissed || transitionOwner?.isBeingDismissed == true {
                if waitingForTransition { return false }
                waitingForTransition = true
                let registered = transitionOwner?.transitionCoordinator?.animate(alongsideTransition: nil) { [weak self] _ in
                        guard let self else { return }
                        self.waitingForTransition = false
                        self.reconcile()
                    } ?? false
                if !next.observeTransitionCompletion(registered: registered) {
                    waitingForTransition = false
                    next.concealAndCancel()
                    configuration?.requestDismiss(next.id, .cancelled)
                }
                return false
            }
            if controller.presentedViewController != nil {
                next.concealAndCancel()
                configuration?.requestDismiss(next.id, .cancelled)
                return false
            }
            ancestor = controller.parent
        }
        return true
    }

    func canShow(_ presentation: NativeCalendarEventEditorPresentation) -> Bool {
        active === presentation && !presentation.cancelled
            && configuration?.presentation === presentation && configuration?.isPresented == true
            && configuration?.canPresent(presentation.id) == true
    }
    func appeared(_ presentation: NativeCalendarEventEditorPresentation) {
        guard canShow(presentation) else { refuse(presentation); return }
        presentation.didAppear()
    }
    func refuse(_ presentation: NativeCalendarEventEditorPresentation) {
        guard active === presentation else { return }
        presentation.concealAndCancel()
        activeRequestDismiss?(presentation.id, presentation.outcome ?? .cancelled)
        dismissIfNeeded(presentation)
    }
    func delegateCompleted(_ presentation: NativeCalendarEventEditorPresentation, outcome: NativeCalendarEventEditorOutcome) {
        guard active === presentation, presentation.completeDelegate(outcome) else { return }
        activeRequestDismiss?(presentation.id, outcome)
        // The model binding update normally performs this; do not retain a
        // completed editor if that SwiftUI update is delayed by another view.
        presentation.concealAndCancel()
        dismissIfNeeded(presentation)
    }
    func adaptiveDismissed(_ presentation: NativeCalendarEventEditorPresentation) {
        guard active === presentation else { return }
        presentation.concealAndCancel()
        activeRequestDismiss?(presentation.id, presentation.outcome ?? .cancelled)
        complete(presentation)
    }

    private func dismissIfNeeded(_ presentation: NativeCalendarEventEditorPresentation) {
        guard active === presentation, presentationCompleted, !dismissalInFlight,
              let editor = presentation.controller,
              let presenter = NativeCalendarEventEditorOwnedUI.dismissalPresenter(for: editor) else { return }
        dismissalInFlight = true
        // Dismissing editor itself can dismiss only a nested screen. Its exact
        // presenter closes the editor and every controller above it together.
        presenter.dismiss(animated: viewIfLoaded?.window != nil) { [self, presentation] in
            complete(presentation)
        }
    }
    private func complete(_ presentation: NativeCalendarEventEditorPresentation) {
        guard active === presentation else { return }
        let completion = activeDidDismiss
        active = nil
        activeRequestDismiss = nil
        activeDidDismiss = nil
        presentationCompleted = false
        dismissalInFlight = false
        completion?(presentation.id)
    }
}

@MainActor
fileprivate final class NativeCalendarEventEditorController: EKEventEditViewController {
    private weak var presentation: NativeCalendarEventEditorPresentation?
    private weak var host: NativeCalendarEventEditorHost?
    private var initialAppearanceChecked = false
    private var initialAppearanceCompleted = false

    init(presentation: NativeCalendarEventEditorPresentation, host: NativeCalendarEventEditorHost) {
        self.presentation = presentation
        self.host = host
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { fatalError("Calendar editor uses its owned initializer") }

    override func viewWillAppear(_ animated: Bool) {
        if !initialAppearanceChecked {
            initialAppearanceChecked = true
            if let presentation, host?.canShow(presentation) != true { host?.refuse(presentation) }
        }
        super.viewWillAppear(animated)
        presentation?.keepCovered()
    }
    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        if !initialAppearanceCompleted {
            initialAppearanceCompleted = true
            if let presentation { host?.appeared(presentation) }
        }
    }
    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        presentation?.keepCovered()
    }
}

@MainActor
fileprivate final class NativeCalendarEventEditorDelegate: NSObject, EKEventEditViewDelegate, UIAdaptivePresentationControllerDelegate {
    private weak var presentation: NativeCalendarEventEditorPresentation?
    private weak var host: NativeCalendarEventEditorHost?
    init(presentation: NativeCalendarEventEditorPresentation, host: NativeCalendarEventEditorHost) {
        self.presentation = presentation
        self.host = host
        super.init()
    }
    func eventEditViewController(_ controller: EKEventEditViewController, didCompleteWith action: EKEventEditViewAction) {
        guard let presentation else { return }
        let outcome: NativeCalendarEventEditorOutcome
        switch action {
        case .saved: outcome = .saved
        case .deleted: outcome = .deleted
        case .canceled: outcome = .cancelled
        @unknown default: outcome = .cancelled
        }
        host?.delegateCompleted(presentation, outcome: outcome)
    }
    func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
        if let presentation { host?.adaptiveDismissed(presentation) }
    }
}
#endif
