const navigationPositionField = "__openVoxelNavigationPositionV1";

function requireBrowserHost(host) {
  if (host === null || typeof host !== "object") {
    throw new TypeError("World exit coordinator requires a browser host");
  }
  const {history, location} = host;
  if (history === null || typeof history !== "object"
    || typeof history.go !== "function" || typeof history.replaceState !== "function"
    || location === null || typeof location !== "object" || typeof location.href !== "string"
    || typeof host.addEventListener !== "function" || typeof host.removeEventListener !== "function") {
    throw new TypeError("World exit coordinator requires browser history, location, and event APIs");
  }
  return {history};
}

function positionFromState(state) {
  if (state === null || typeof state !== "object") return null;
  const position = state[navigationPositionField];
  return Number.isSafeInteger(position) ? position : null;
}

function stateAtPosition(state, position) {
  if (state !== null && typeof state === "object" && !Array.isArray(state)) {
    return {...state, [navigationPositionField]: position};
  }
  return {[navigationPositionField]: position};
}

export function createWorldExitCoordinator(host = globalThis) {
  const {history} = requireBrowserHost(host);
  let currentPosition = positionFromState(history.state) ?? 0;
  let activeWorld = null;
  let applicationNavigationDepth = 0;
  let disposed = false;

  const markCurrentEntry = (position) => {
    history.replaceState(stateAtPosition(history.state, position), "", host.location.href);
  };
  markCurrentEntry(currentPosition);

  const beforeUnload = (event) => {
    if (activeWorld === null) return;
    event.preventDefault();
    event.returnValue = true;
  };

  const historyLeave = (event) => {
    if (applicationNavigationDepth > 0) return;
    const targetPosition = positionFromState(event.state ?? history.state);
    const world = activeWorld;
    if (world === null) {
      if (targetPosition !== null) currentPosition = targetPosition;
      return;
    }

    event.stopImmediatePropagation();
    if (targetPosition === null) {
      throw new Error("OpenVoxel encountered an untracked same-document history entry");
    }
    currentPosition = targetPosition;

    if (world.restoring) {
      if (targetPosition !== world.position) {
        throw new Error("OpenVoxel could not restore the protected world history entry");
      }
      world.restoring = false;
      if (world.confirmationPending) return;
      world.confirmationPending = true;
      try {
        world.requestConfirmation();
      } catch (error) {
        world.confirmationPending = false;
        world.targetPosition = null;
        throw error;
      }
      return;
    }

    if (targetPosition === world.position) return;
    world.targetPosition = targetPosition;
    world.restoring = true;
    history.go(world.position - targetPosition);
  };

  host.addEventListener("beforeunload", beforeUnload, true);
  host.addEventListener("popstate", historyLeave, true);

  const release = (world) => {
    if (activeWorld !== world) return false;
    activeWorld = null;
    world.confirmationPending = false;
    world.restoring = false;
    return true;
  };

  const navigate = (to, options, runtimeNavigate) => {
    if (disposed) throw new Error("Disposed world exit coordinator cannot navigate");
    if (typeof runtimeNavigate !== "function") {
      throw new TypeError("Application navigation requires the Velar Web navigate function");
    }
    const previousPosition = currentPosition;
    const nextPosition = options?.replace === true ? previousPosition : previousPosition + 1;
    if (!Number.isSafeInteger(nextPosition)) throw new RangeError("OpenVoxel navigation history is exhausted");
    const previousHref = host.location.href;
    currentPosition = nextPosition;
    applicationNavigationDepth += 1;
    try {
      const result = runtimeNavigate(to, options);
      markCurrentEntry(nextPosition);
      return result;
    } catch (error) {
      if (host.location.href === previousHref) currentPosition = previousPosition;
      else markCurrentEntry(nextPosition);
      throw error;
    } finally {
      applicationNavigationDepth -= 1;
    }
  };

  return Object.freeze({
    activate(requestConfirmation) {
      if (disposed) throw new Error("Disposed world exit coordinator cannot activate a world");
      if (activeWorld !== null) throw new Error("A world exit guard is already active");
      if (typeof requestConfirmation !== "function") {
        throw new TypeError("World exit guard requires a history confirmation callback");
      }
      const world = {
        confirmationPending: false,
        position: currentPosition,
        requestConfirmation,
        restoring: false,
        targetPosition: null,
      };
      activeWorld = world;
      return Object.freeze({
        allow() {
          release(world);
          return null;
        },
        cancelHistoryLeave() {
          if (activeWorld === world) {
            world.confirmationPending = false;
            world.targetPosition = null;
          }
          return null;
        },
        confirmHistoryLeave() {
          const targetPosition = world.targetPosition;
          if (targetPosition !== null && release(world)) {
            world.targetPosition = null;
            history.go(targetPosition - currentPosition);
          }
          return null;
        },
        dispose() {
          release(world);
          return null;
        },
      });
    },
    navigate,
    dispose() {
      if (disposed) return null;
      disposed = true;
      activeWorld = null;
      host.removeEventListener("beforeunload", beforeUnload, true);
      host.removeEventListener("popstate", historyLeave, true);
      return null;
    },
  });
}

export function releaseCanvasPointerLock(canvas, documentHost = globalThis.document) {
  if (documentHost === null || typeof documentHost !== "object") return null;
  if (documentHost.pointerLockElement !== canvas) return null;
  const exitPointerLock = documentHost.exitPointerLock;
  if (typeof exitPointerLock !== "function") {
    throw new TypeError("The active pointer lock cannot be released");
  }
  exitPointerLock.call(documentHost);
  return null;
}

export function captureApplicationLinkClick(event) {
  if (event === null || typeof event !== "object" || typeof event.preventDefault !== "function") {
    throw new TypeError("Application links require a browser click event");
  }
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
    return false;
  }
  event.preventDefault();
  return true;
}

let applicationCoordinator = null;

export function installWorldExitCoordinator() {
  if (applicationCoordinator === null) applicationCoordinator = createWorldExitCoordinator();
  return null;
}

export function navigateWithHistoryPosition(to, options, runtimeNavigate) {
  if (applicationCoordinator === null) {
    throw new Error("World exit coordinator must be installed before application navigation");
  }
  return applicationCoordinator.navigate(to, options, runtimeNavigate);
}

export function createWorldExitGuard(requestHistoryConfirmation) {
  if (applicationCoordinator === null) {
    throw new Error("World exit coordinator must be installed before the application Router mounts");
  }
  return applicationCoordinator.activate(requestHistoryConfirmation);
}
