public struct NativeHeldTapOrigin<Context: Equatable & Sendable>: Sendable {
    public let heldAt: ContinuousClock.Instant
    public let context: Context
}

public struct NativeHeldTap<Context: Equatable & Sendable, Action> {
    public static var lifetime: Duration { .seconds(1) }

    private var pending: (action: Action, origin: NativeHeldTapOrigin<Context>)?

    public init() {}

    public var isHolding: Bool { pending != nil }

    public mutating func hold(_ action: Action, context: Context, now: ContinuousClock.Instant,
                              replaying origin: NativeHeldTapOrigin<Context>?) {
        pending = (action, origin ?? NativeHeldTapOrigin(heldAt: now, context: context))
    }

    public mutating func take(context: Context, now: ContinuousClock.Instant)
        -> (action: Action, origin: NativeHeldTapOrigin<Context>)? {
        guard let held = pending else { return nil }
        pending = nil
        guard now - held.origin.heldAt < Self.lifetime, held.origin.context == context else { return nil }
        return held
    }
}
